//! Roll up immutable worker captures through the persisted team relationship.
//! The returned source IDs must be saved with the parent summary in the same transaction.
use super::*;
use std::collections::{BinaryHeap, VecDeque};

const SOURCES: usize = 200;
const INITIAL_WORKER_PAGE: i64 = 32;
const MAX_WORKER_PAGE: i64 = 2048;
const WORKER_FIRST_PAGE_SQL: &str = "SELECT id, message_id FROM turn_changes
     WHERE session_id=?1 AND json_extract(summary,'$.attributed')=1
     ORDER BY message_id DESC LIMIT ?2";
const WORKER_NEXT_PAGE_SQL: &str = "SELECT id, message_id FROM turn_changes
     WHERE session_id=?1 AND message_id < ?2 AND json_extract(summary,'$.attributed')=1
     ORDER BY message_id DESC LIMIT ?3";

pub(super) fn merge(store: &Store, sid: &str, capture: &mut Captured) -> Result<Vec<String>> {
    // A checkout-wide legacy capture cannot become owned by mixing in scoped edits.
    if !capture.summary.attributed {
        return Ok(vec![]);
    }
    let candidates = unmerged_sources(store, sid)?;
    let mut summaries = store
        .db
        .prepare_cached("SELECT summary FROM turn_changes WHERE id=?1")
        .map_err(|e| e.to_string())?;
    let mut files: BTreeMap<_, _> = capture
        .summary
        .files
        .iter()
        .cloned()
        .map(|f| (f.path.clone(), f))
        .collect();
    let mut details: BTreeMap<_, _> = capture
        .details
        .iter()
        .cloned()
        .map(|d| (d.path.clone(), d))
        .collect();
    let mut patch_bytes: usize = details.values().map(|d| d.patch.len()).sum();
    let mut summary_bytes = 0usize;
    let mut sources = Vec::new();
    for (source, worker_sid) in candidates {
        let json: String = summaries
            .query_row([&source], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        summary_bytes = summary_bytes.saturating_add(json.len());
        if sources.len() == SOURCES || summary_bytes > TURN_BYTES {
            limited(&mut capture.summary);
            break;
        }
        let worker: TurnChanges = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        sources.push(source.clone());
        capture.summary.truncated |= worker.truncated;
        capture.summary.concurrent |= worker.concurrent;
        if capture.summary.error.is_none() {
            capture.summary.error = worker.error;
        }
        for mut file in worker.files {
            if !safe_relative(&file.path)
                || (!files.contains_key(&file.path) && files.len() >= CHANGE_FILES)
            {
                limited(&mut capture.summary);
                continue;
            }
            let mut previous = detail(store, &worker_sid, &source, &file.path)?;
            let current_bytes = details.get(&file.path).map_or(0, |d| d.patch.len());
            let separator = usize::from(current_bytes > 0 && !previous.patch.is_empty());
            let available = PATCH_BYTES
                .saturating_sub(current_bytes + separator)
                .min(TURN_BYTES.saturating_sub(patch_bytes + separator));
            if previous.patch.len() > available {
                truncate_patch(&mut previous.patch, available);
                previous.truncated = true;
                previous
                    .error
                    .get_or_insert_with(|| "Team diff preview reached its size limit.".into());
            }
            file.truncated |= previous.truncated;
            capture.summary.truncated |= previous.truncated;
            if let Some(current) = files.get_mut(&file.path) {
                // Sources are newest first. Retain the latest status while recording
                // cumulative edits; their patches remain separate immutable hunks.
                if current.status == "modified" {
                    if file.status == "added" {
                        current.status = "added".into();
                    } else if file.status == "renamed" {
                        current.status = "renamed".into();
                        current.old_path = file.old_path.clone();
                    }
                }
                current.additions = sum_counts(current.additions, file.additions);
                current.deletions = sum_counts(current.deletions, file.deletions);
                current.binary |= file.binary;
                current.truncated |= file.truncated;
            } else {
                files.insert(file.path.clone(), file.clone());
            }
            let previous_bytes = previous.patch.len();
            if let Some(current) = details.get_mut(&file.path) {
                if !previous.patch.is_empty() && !current.patch.is_empty() {
                    previous.patch.push('\n');
                }
                let added = previous.patch.len();
                previous.patch.push_str(&current.patch);
                current.patch = previous.patch;
                current.old_path = files[&file.path].old_path.clone();
                current.binary |= previous.binary;
                current.truncated |= previous.truncated;
                if current.error.is_none() {
                    current.error = previous.error;
                }
                patch_bytes = patch_bytes.saturating_add(added);
            } else {
                details.insert(file.path, previous);
                patch_bytes = patch_bytes.saturating_add(previous_bytes);
            }
        }
    }
    capture.summary.files = files.into_values().collect();
    capture.summary.additions = capture
        .summary
        .files
        .iter()
        .filter_map(|f| f.additions)
        .fold(0, usize::saturating_add);
    capture.summary.deletions = capture
        .summary
        .files
        .iter()
        .filter_map(|f| f.deletions)
        .fold(0, usize::saturating_add);
    capture.details = details.into_values().collect();
    Ok(sources)
}

/// `(id, session_id)` of the finished workers' attributed captures this conversation has not
/// rolled up yet, newest first, at most `SOURCES + 1` (one more tells the limit was reached).
/// Read the parent summaries' `teamSources` once, after finding the first candidate.
fn unmerged_sources(store: &Store, sid: &str) -> Result<Vec<(String, String)>> {
    let has_workers: bool = store
        .db
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM architect_workers WHERE parent_session_id=?1)")
        .and_then(|mut q| q.query_row([sid], |r| r.get(0)))
        .map_err(|e| e.to_string())?;
    if !has_workers {
        return Ok(Vec::new());
    }

    let worker_sessions = {
        let mut query = store.db.prepare_cached(
            "SELECT DISTINCT relation.session_id FROM architect_workers relation
             JOIN architect_teams team ON team.session_id=relation.parent_session_id
             JOIN json_each(team.content,'$.workers') worker
               ON json_extract(worker.value,'$.sessionId')=relation.session_id
              AND json_extract(worker.value,'$.id')=relation.worker_id
             WHERE relation.parent_session_id=?1
               AND json_extract(worker.value,'$.status') IN ('completed','failed','stopped')",
        ).map_err(|e| e.to_string())?;
        let rows = query
            .query_map([sid], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?
    };
    if worker_sessions.is_empty() {
        return Ok(Vec::new());
    }

    // Message IDs are unique across workers, so each page contributes only its head.
    let mut heap = BinaryHeap::with_capacity(worker_sessions.len());
    let mut pages = Vec::with_capacity(worker_sessions.len());
    for (worker_idx, worker_sid) in worker_sessions.iter().enumerate() {
        let page = worker_page(store, worker_sid, None, INITIAL_WORKER_PAGE)?;
        if let Some((_, message_id)) = page.rows.front() {
            heap.push((*message_id, worker_idx));
        }
        pages.push(page);
    }
    let mut merged = None;
    let mut candidates = Vec::new();
    while let Some((message_id, worker_idx)) = heap.pop() {
        let page = &mut pages[worker_idx];
        let worker_sid = &worker_sessions[worker_idx];
        let (id, _) = page
            .rows
            .pop_front()
            .expect("heap entry has a buffered source");
        let merged = match &mut merged {
            Some(merged) => merged,
            slot @ None => slot.insert(merged_sources(store, sid)?),
        };
        if !merged.contains(id.as_bytes()) {
            candidates.push((id, worker_sid.clone()));
            if candidates.len() > SOURCES {
                return Ok(candidates);
            }
        }
        if page.rows.is_empty() && !page.exhausted {
            // Keep the first read small and amortize fetches when walking deep history.
            let next_limit = (page.limit * 4).min(MAX_WORKER_PAGE);
            *page = worker_page(store, worker_sid, Some(message_id), next_limit)?;
        }
        if let Some((_, next_message_id)) = page.rows.front() {
            heap.push((*next_message_id, worker_idx));
        }
    }
    Ok(candidates)
}

struct WorkerPage {
    rows: VecDeque<(String, i64)>,
    exhausted: bool,
    limit: i64,
}

fn worker_page(store: &Store, sid: &str, before: Option<i64>, limit: i64) -> Result<WorkerPage> {
    let sql = if before.is_some() {
        WORKER_NEXT_PAGE_SQL
    } else {
        WORKER_FIRST_PAGE_SQL
    };
    let mut query = store.db.prepare_cached(sql).map_err(|e| e.to_string())?;
    let rows = match before {
        Some(message_id) => query.query(params![sid, message_id, limit]),
        None => query.query(params![sid, limit]),
    }
    .map_err(|e| e.to_string())?;
    let rows = rows
        .mapped(|r| Ok((r.get(0)?, r.get(1)?)))
        .collect::<rusqlite::Result<VecDeque<_>>>()
        .map_err(|e| e.to_string())?;
    // LIMIT counts only attributed rows. A short page has no more matching history.
    let exhausted = rows.len() < limit as usize;
    Ok(WorkerPage { rows, exhausted, limit })
}

fn merged_sources(store: &Store, sid: &str) -> Result<std::collections::HashSet<Vec<u8>>> {
    // Apply the ID column's text affinity, then read the bytes to preserve lone surrogates.
    let mut query = store
        .db
        .prepare_cached(
            "SELECT CAST(CAST(source.value AS TEXT) AS BLOB)
             FROM turn_changes parent, json_each(parent.summary,'$.teamSources') source
             WHERE parent.session_id=?1 AND source.value IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([sid], |r| r.get::<_, Vec<u8>>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

fn sum_counts(a: Option<usize>, b: Option<usize>) -> Option<usize> {
    a.zip(b).map(|(a, b)| a.saturating_add(b))
}

fn limited(summary: &mut TurnChanges) {
    summary.truncated = true;
    summary
        .error
        .get_or_insert_with(|| "Some team changes exceeded this turn's preview limit.".into());
}

fn truncate_patch(patch: &mut String, limit: usize) {
    let mut end = limit.min(patch.len());
    while !patch.is_char_boundary(end) {
        end -= 1;
    }
    patch.truncate(end);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn capture(path: &str, text: &str) -> Captured {
        Captured {
            summary: TurnChanges {
                id: storage::id(),
                files: vec![ChangedFile {
                    path: path.into(),
                    old_path: None,
                    status: "modified".into(),
                    additions: Some(1),
                    deletions: Some(1),
                    binary: false,
                    truncated: false,
                }],
                additions: 1,
                deletions: 1,
                truncated: false,
                concurrent: false,
                attributed: true,
                error: None,
            },
            details: vec![TurnChangeDiff {
                path: path.into(),
                old_path: None,
                patch: text.into(),
                binary: false,
                truncated: false,
                error: None,
            }],
        }
    }

    fn empty() -> Captured {
        let mut capture = capture("unused", "");
        capture.summary.files.clear();
        capture.summary.additions = 0;
        capture.summary.deletions = 0;
        capture.details.clear();
        capture
    }

    struct TeamFixture {
        _files: super::super::tests::Fixture,
        store: Store,
        parent: String,
        worker: String,
        unrelated: String,
    }

    impl TeamFixture {
        fn new() -> Self {
            let files = super::super::tests::Fixture::new(false);
            let store = Store::open(&files.root.join("state.sqlite")).unwrap();
            let project = store.add_project(&files.root).unwrap();
            let parent = store
                .create_session(&project.id, "codex", "default", "ask")
                .unwrap()
                .id;
            let worker = store
                .create_session(&project.id, "codex", "default", "ask")
                .unwrap()
                .id;
            let unrelated = store
                .create_session(&project.id, "codex", "default", "ask")
                .unwrap()
                .id;
            store.db.execute("INSERT INTO architect_workers(parent_session_id,worker_id,session_id) VALUES(?1,'worker',?2)", params![parent,worker]).unwrap();
            let content = json!({"workers":[{"id":"worker","sessionId":worker,"status":"completed","abandoned":false}]}).to_string();
            store
                .db
                .execute(
                    "INSERT INTO architect_teams(session_id,content) VALUES(?1,?2)",
                    params![parent, content],
                )
                .unwrap();
            Self {
                _files: files,
                store,
                parent,
                worker,
                unrelated,
            }
        }
        fn state(&self, status: &str, abandoned: bool) {
            self.store.db.execute("UPDATE architect_teams SET content=json_set(content,'$.workers[0].status',?2,'$.workers[0].abandoned',?3) WHERE session_id=?1", params![self.parent,status,abandoned]).unwrap();
        }

        fn finished_workers(&self) -> Vec<String> {
            let project = self.store.session(&self.parent).unwrap().project_id;
            let mut workers = vec![self.worker.clone()];
            let mut roster = vec![json!({"id":"worker","sessionId":self.worker,"status":"completed"})];
            for (idx, status) in ["completed", "failed", "stopped"].into_iter().enumerate() {
                let worker = self
                    .store
                    .create_session(&project, "codex", "default", "ask")
                    .unwrap()
                    .id;
                let id = format!("worker-{idx}");
                self.store.db.execute(
                    "INSERT INTO architect_workers(parent_session_id,worker_id,session_id) VALUES(?1,?2,?3)",
                    params![self.parent, id, worker],
                ).unwrap();
                roster.push(json!({"id":id,"sessionId":worker,"status":status}));
                workers.push(worker);
            }
            self.store.db.execute(
                "UPDATE architect_teams SET content=?2 WHERE session_id=?1",
                params![self.parent, json!({"workers":roster}).to_string()],
            ).unwrap();
            workers
        }
    }

    #[test]
    fn solo_thread_never_reads_team_or_changes_after_analyze() {
        let f = TeamFixture::new();
        for _ in 0..500 {
            persist(&f.store, &f.worker, empty()).unwrap();
        }
        f.store.db.execute_batch("ANALYZE").unwrap();
        f.store.db.flush_prepared_statement_cache();

        use rusqlite::ffi;
        unsafe extern "C" fn deny_team_and_turn_changes(
            _: *mut std::ffi::c_void,
            action: std::ffi::c_int,
            table: *const std::ffi::c_char,
            _: *const std::ffi::c_char,
            _: *const std::ffi::c_char,
            _: *const std::ffi::c_char,
        ) -> std::ffi::c_int {
            // SAFETY: SQLite supplies a non-null table name for SQLITE_READ.
            if action == ffi::SQLITE_READ
                && matches!(
                    unsafe { std::ffi::CStr::from_ptr(table) }.to_bytes(),
                    b"architect_teams" | b"turn_changes"
                )
            {
                ffi::SQLITE_DENY
            } else {
                ffi::SQLITE_OK
            }
        }

        // SAFETY: The connection is live and the callback requires no context.
        unsafe {
            ffi::sqlite3_set_authorizer(
                f.store.db.handle(),
                Some(deny_team_and_turn_changes),
                std::ptr::null_mut(),
            );
        }
        assert_eq!(unmerged_sources(&f.store, &f.unrelated), Ok(vec![]));
    }

    #[test]
    fn worker_pages_search_the_session_index_in_order() {
        let f = TeamFixture::new();
        let message_id = persist(&f.store, &f.worker, empty()).unwrap();
        f.store.db.execute_batch("ANALYZE").unwrap();
        let check = |sql: &str, bindings: &[&dyn rusqlite::ToSql], expected: &str| {
            let mut query = f.store.db.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            let plan = query
                .query_map(bindings, |row| row.get::<_, String>(3))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            assert_eq!(plan, [expected]);
        };
        check(
            WORKER_FIRST_PAGE_SQL,
            params![f.worker, INITIAL_WORKER_PAGE],
            "SEARCH turn_changes USING INDEX turn_changes_session (session_id=?)",
        );
        check(
            WORKER_NEXT_PAGE_SQL,
            params![f.worker, message_id, MAX_WORKER_PAGE],
            "SEARCH turn_changes USING INDEX turn_changes_session (session_id=? AND message_id<?)",
        );
    }

    #[test]
    fn lone_surrogate_in_team_sources_preserves_unmerged_captures() {
        let f = TeamFixture::new();
        let workers = f.finished_workers();
        let parent_message = persist(&f.store, &f.parent, empty()).unwrap();
        f.store.db.execute(
            "UPDATE turn_changes SET summary=?2 WHERE message_id=?1",
            params![parent_message, r#"{"teamSources":["\uD800","already-merged"]}"#],
        ).unwrap();
        for (id, worker) in [
            ("already-merged", &workers[0]),
            ("unmerged-a", &workers[0]),
            ("unmerged-b", &workers[1]),
        ] {
            let mut capture = empty();
            capture.summary.id = id.into();
            capture.summary.attributed = true;
            persist(&f.store, worker, capture).unwrap();
        }
        assert_eq!(
            unmerged_sources(&f.store, &f.parent).unwrap(),
            [("unmerged-b".into(), workers[1].clone()), ("unmerged-a".into(), workers[0].clone())]
        );
    }

    #[test]
    fn dense_team_returns_newest_unmerged_captures_across_workers_and_pages() {
        let f = TeamFixture::new();
        let workers = f.finished_workers();
        let parent_messages = [(); 2].map(|()| persist(&f.store, &f.parent, empty()).unwrap());
        let mut expected = Vec::new();
        for i in 0..700 {
            let worker = &workers[i % workers.len()];
            let mut capture = empty();
            // IDs sort opposite to message IDs, so an ID-only ordering fails.
            let id = format!("capture-{:03}", 699 - i);
            capture.summary.id = id.clone();
            capture.summary.attributed = i % 7 != 0;
            if capture.summary.attributed {
                expected.push((id, worker.clone()));
            }
            persist(&f.store, worker, capture).unwrap();
        }
        expected.reverse();
        let (merged, expected) = expected.split_at(250);
        for (parent_message, sources) in parent_messages.into_iter().zip(merged.chunks(125)) {
            let ids = sources.iter().map(|(id, _)| id).collect::<Vec<_>>();
            f.store.db.execute(
                "UPDATE turn_changes SET summary=json_set(summary,'$.teamSources',json(?2))
                 WHERE message_id=?1",
                params![parent_message, json!(ids).to_string()],
            ).unwrap();
        }
        assert_eq!(
            unmerged_sources(&f.store, &f.parent).unwrap(),
            expected[..SOURCES + 1]
        );

        // Persist the first rollup, then check the lookahead row and the remaining short pages.
        persist(&f.store, &f.parent, empty()).unwrap();
        assert_eq!(
            unmerged_sources(&f.store, &f.parent).unwrap(),
            expected[SOURCES..]
        );
    }

    #[test]
    fn fully_merged_team_exhausts_its_history_in_three_pages_per_worker() {
        use rusqlite::ffi;
        use std::cell::Cell;
        use std::ffi::{c_int, c_uint, c_void, CStr};

        unsafe extern "C" fn count_worker_pages(
            _: c_uint,
            context: *mut c_void,
            _: *mut c_void,
            sql: *mut c_void,
        ) -> c_int {
            // SAFETY: SQLITE_TRACE_STMT supplies SQL text and the context points to the counter.
            let sql = unsafe { CStr::from_ptr(sql.cast()) }.to_bytes();
            if sql == WORKER_FIRST_PAGE_SQL.as_bytes() || sql == WORKER_NEXT_PAGE_SQL.as_bytes() {
                let fetches = unsafe { &*context.cast::<Cell<usize>>() };
                fetches.set(fetches.get() + 1);
            }
            0
        }

        let fetches = Cell::new(0usize);
        let f = TeamFixture::new();
        let workers = f.finished_workers();
        for worker in workers.iter().cycle().take(1_000) {
            persist(&f.store, worker, empty()).unwrap();
        }
        for _ in 0..1_000 / SOURCES {
            persist(&f.store, &f.parent, empty()).unwrap();
        }

        // SAFETY: The connection is live, and fetches outlives its trace registration.
        let rc = unsafe {
            ffi::sqlite3_trace_v2(
                f.store.db.handle(),
                ffi::SQLITE_TRACE_STMT as _,
                Some(count_worker_pages),
                std::ptr::from_ref(&fetches).cast_mut().cast(),
            )
        };
        assert_eq!(rc, ffi::SQLITE_OK);
        assert_eq!(unmerged_sources(&f.store, &f.parent), Ok(vec![]));
        assert_eq!(fetches.get(), 12);
    }

    #[test]
    fn solo_thread_skips_invalid_prior_summaries() {
        let f = TeamFixture::new();
        persist(&f.store, &f.unrelated, capture("solo.txt", "+solo")).unwrap();
        f.store
            .db
            .execute_batch("PRAGMA ignore_check_constraints=ON")
            .unwrap();
        assert_eq!(
            f.store
                .db
                .execute(
                    "UPDATE turn_changes SET summary='invalid json' WHERE session_id=?1",
                    [&f.unrelated],
                )
                .unwrap(),
            1
        );
        f.store
            .db
            .execute_batch("PRAGMA ignore_check_constraints=OFF")
            .unwrap();
        assert!(unmerged_sources(&f.store, &f.unrelated).unwrap().is_empty());
    }

    #[test]
    fn completed_worker_edits_join_parent_without_other_tasks_or_legacy_changes() {
        let f = TeamFixture::new();
        persist(&f.store, &f.worker, capture("worker.txt", "+worker")).unwrap();
        persist(
            &f.store,
            &f.unrelated,
            capture("unrelated.txt", "+unrelated"),
        )
        .unwrap();
        let mut legacy = capture("legacy.txt", "+legacy");
        legacy.summary.attributed = false;
        persist(&f.store, &f.worker, legacy).unwrap();
        let mut parent = capture("parent.txt", "+parent");
        let sources = merge(&f.store, &f.parent, &mut parent).unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(
            parent
                .summary
                .files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            ["parent.txt", "worker.txt"]
        );
        assert_eq!(parent.summary.additions, 2);
        assert_eq!(parent.details[1].patch, "+worker");
        assert!(parent.summary.attributed);
    }

    #[test]
    fn active_workers_wait_while_failed_and_abandoned_workers_keep_their_edits() {
        let f = TeamFixture::new();
        persist(&f.store, &f.worker, capture("worker.txt", "+worker")).unwrap();
        for status in ["queued", "running", "waiting"] {
            f.state(status, false);
            assert!(merge(&f.store, &f.parent, &mut empty()).unwrap().is_empty());
        }
        for (status, abandoned) in [("completed", false), ("failed", false), ("stopped", true)] {
            f.state(status, abandoned);
            assert_eq!(merge(&f.store, &f.parent, &mut empty()).unwrap().len(), 1);
        }
    }

    #[test]
    fn persisted_sources_are_imported_once_and_new_followup_captures_remain_eligible() {
        let f = TeamFixture::new();
        persist(&f.store, &f.worker, capture("worker.txt", "first")).unwrap();
        let parent = empty();
        let id = parent.summary.id.clone();
        persist(&f.store, &f.parent, parent).unwrap();
        assert_eq!(summary(&f.store, &f.parent, &id).unwrap().files.len(), 1);
        let source_count: i64 = f
            .store
            .db
            .query_row(
                "SELECT json_array_length(summary,'$.teamSources') FROM turn_changes WHERE id=?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(source_count, 1);
        assert!(merge(&f.store, &f.parent, &mut empty()).unwrap().is_empty());
        persist(&f.store, &f.worker, capture("followup.txt", "second")).unwrap();
        let mut next = empty();
        assert_eq!(merge(&f.store, &f.parent, &mut next).unwrap().len(), 1);
        assert_eq!(next.summary.files[0].path, "followup.txt");
    }

    #[test]
    fn shared_path_keeps_chronological_patches_and_one_file_row() {
        let f = TeamFixture::new();
        persist(&f.store, &f.worker, capture("shared.txt", "first")).unwrap();
        persist(&f.store, &f.worker, capture("shared.txt", "second")).unwrap();
        let mut parent = capture("shared.txt", "parent");
        merge(&f.store, &f.parent, &mut parent).unwrap();
        assert_eq!(parent.summary.files.len(), 1);
        assert_eq!(parent.summary.additions, 3);
        assert_eq!(parent.details[0].patch, "first\nsecond\nparent");
    }

    #[test]
    fn worker_rename_is_preserved_when_parent_edits_the_destination() {
        let f = TeamFixture::new();
        let mut worker = capture("renamed.txt", "rename");
        worker.summary.files[0].status = "renamed".into();
        worker.summary.files[0].old_path = Some("original.txt".into());
        worker.details[0].old_path = Some("original.txt".into());
        persist(&f.store, &f.worker, worker).unwrap();
        let mut parent = capture("renamed.txt", "parent");
        merge(&f.store, &f.parent, &mut parent).unwrap();
        assert_eq!(parent.summary.files[0].status, "renamed");
        assert_eq!(
            parent.summary.files[0].old_path.as_deref(),
            Some("original.txt")
        );
        assert_eq!(parent.details[0].old_path.as_deref(), Some("original.txt"));
    }

    #[test]
    fn rollup_bounds_files_and_patch_bytes_and_preserves_own_capture() {
        let f = TeamFixture::new();
        persist(
            &f.store,
            &f.worker,
            capture("worker.txt", &"🦀".repeat(PATCH_BYTES / 4)),
        )
        .unwrap();
        let mut parent = capture("worker.txt", "parent");
        for i in 1..CHANGE_FILES {
            let extra = capture(&format!("own-{i}.txt"), "own");
            parent.summary.files.extend(extra.summary.files);
            parent.details.extend(extra.details);
        }
        persist(&f.store, &f.worker, capture("overflow.txt", "overflow")).unwrap();
        merge(&f.store, &f.parent, &mut parent).unwrap();
        assert_eq!(parent.summary.files.len(), CHANGE_FILES);
        assert!(!parent
            .summary
            .files
            .iter()
            .any(|f| f.path == "overflow.txt"));
        let shared = parent
            .details
            .iter()
            .find(|d| d.path == "worker.txt")
            .unwrap();
        assert!(shared.patch.len() <= PATCH_BYTES);
        assert!(shared.patch.ends_with("parent"));
        assert!(parent.summary.truncated);
        assert!(parent.details.iter().map(|d| d.patch.len()).sum::<usize>() <= TURN_BYTES);
    }

    #[test]
    fn total_patch_budget_is_shared_across_worker_captures() {
        let f = TeamFixture::new();
        for i in 0..10 {
            persist(
                &f.store,
                &f.worker,
                capture(&format!("worker-{i}.txt"), &"x".repeat(PATCH_BYTES)),
            )
            .unwrap();
        }
        let mut parent = empty();
        merge(&f.store, &f.parent, &mut parent).unwrap();
        assert_eq!(parent.summary.files.len(), 10);
        assert_eq!(
            parent.details.iter().map(|d| d.patch.len()).sum::<usize>(),
            TURN_BYTES
        );
        assert!(parent.summary.truncated);
    }
}
