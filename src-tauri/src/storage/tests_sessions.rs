//! Store tests for projects, tasks, drafts, the board, task configuration and search, plus
//! `empty_session`, the in-memory store with one task that the other storage tests share.
use super::*;

pub(super) fn empty_session() -> (Store, Session) {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let session = store
        .create_session(&project.id, "claude", "sonnet", "auto")
        .unwrap();
    (store, session)
}

#[test]
fn missing_sessions_lists_only_ids_with_no_row_at_all() {
    let (store, task) = empty_session();
    let draft = store.create_session(&task.project_id, "claude", "sonnet", "auto").unwrap();
    store.mark_draft(&draft.id).unwrap();
    let archived = store.create_session(&task.project_id, "claude", "sonnet", "auto").unwrap();
    store.db.execute("UPDATE sessions SET archived=1 WHERE id=?1", [&archived.id]).unwrap();
    let ids: Vec<String> = ["gone-1", &task.id, &draft.id, "x' OR 1=1 --", &archived.id, "gone-2"].iter().map(|s| s.to_string()).collect();
    assert_eq!(store.missing_sessions(&ids).unwrap(), ["gone-1", "x' OR 1=1 --", "gone-2"]);
    assert_eq!(store.missing_sessions(&[]).unwrap(), Vec::<String>::new());
    let many: Vec<String> = (0..MAX_MISSING_IDS).map(|i| format!("id-{i}")).collect();
    assert_eq!(store.missing_sessions(&many).unwrap().len(), MAX_MISSING_IDS);
    let too_many: Vec<String> = (0..=MAX_MISSING_IDS).map(|i| format!("id-{i}")).collect();
    assert!(store.missing_sessions(&too_many).is_err());
    assert!(store.missing_sessions(&["é".repeat(MAX_MISSING_ID_CHARS)]).is_ok());
    assert!(store.missing_sessions(&["a".repeat(MAX_MISSING_ID_CHARS + 1)]).is_err());
}

/// Launch lookups consider only rows whose stored path could name the folder.
#[test]
fn launch_project_lookup_filters_rows_by_path_before_resolving_links() {
    let root = std::env::temp_dir().join(format!("pandacode-launch-{}", uuid::Uuid::new_v4()));
    let (main, worktree, other) = (root.join("main"), root.join("tree"), root.join("other"));
    for dir in [&main, &worktree, &other] {
        std::fs::create_dir_all(dir).unwrap();
    }
    let store = Store::open(Path::new(":memory:")).unwrap();
    let project = store.add_project(&main).unwrap();
    let unrelated = store.add_project(&other).unwrap();
    let task = store
        .create_session(&project.id, "claude", "default", "ask")
        .unwrap();
    store
        .create_worktree_session_on(&task, &worktree, None)
        .unwrap();
    // Rows that can't name the folder are left out by SQL before anything is resolved.
    for i in 0..20 {
        let folder = root.join(format!("unrelated-{i}"));
        std::fs::create_dir_all(&folder).unwrap();
        let task = store
            .create_session(&unrelated.id, "claude", "default", "ask")
            .unwrap();
        store
            .create_worktree_session_on(&task, &folder, None)
            .unwrap();
    }
    let id = |cwd: &Path| store.launch_project_at(cwd).unwrap().map(|(id, _)| id);
    assert_eq!(id(&worktree), Some(project.id.clone()));
    assert_eq!(
        id(&root.join("other").join("..").join("tree")),
        Some(project.id.clone())
    );
    assert_eq!(id(&main.join(".")), Some(project.id.clone()));
    assert_eq!(id(&other), Some(unrelated.id.clone()));
    assert_eq!(id(&root), None);
    #[cfg(unix)]
    {
        // A link with another name still resolves through the folder it points at.
        let link = root.join("linked");
        std::os::unix::fs::symlink(&worktree, &link).unwrap();
        assert_eq!(id(&link), Some(project.id.clone()));
    }
    let [given, resolved, ..] = launch_path_patterns(&worktree, &worktree);
    assert_eq!(
        (given.as_str(), resolved.as_str()),
        (worktree.to_str().unwrap(), worktree.to_str().unwrap())
    );
    let _ = std::fs::remove_dir_all(root);
}

/// Usage-limit resumes list only flagged tasks whose reset has passed (serve mode).
#[test]
fn limit_resumes_are_only_the_due_flagged_live_tasks() {
    let (store, due) = empty_session();
    let future = store.create_session(&due.project_id, "claude", "sonnet", "auto").unwrap();
    let draft = store.create_session(&due.project_id, "claude", "sonnet", "auto").unwrap();
    store.mark_draft(&draft.id).unwrap();
    for (sid, until) in [(&due.id, Some(1000)), (&future.id, Some(4_000_000_000_000)), (&draft.id, Some(1000))] {
        store.set_limited(sid, until).unwrap();
        store.set_resume_at_reset(sid, true).unwrap();
    }
    assert!(store.due_limit_resumes(500).unwrap().is_empty());
    assert_eq!(store.due_limit_resumes(2000).unwrap(), vec![due.id.clone()]);
    // A task that is no longer flagged waits like any other.
    store.set_resume_at_reset(&due.id, false).unwrap();
    assert!(store.due_limit_resumes(2000).unwrap().is_empty());
}

#[test]
fn a_new_task_published_after_a_manual_reorder_is_listed_first_and_stays_there() {
    let (store, first) = empty_session();
    let second = store.create_session(&first.project_id, "claude", "sonnet", "auto").unwrap();
    let ids = |store: &Store| store.sessions().unwrap().into_iter().map(|task| task.id).collect::<Vec<_>>();
    // Nothing arranged yet: a published draft stays unranked and activity orders the list.
    let early = store.mark_draft(&store.create_session(&first.project_id, "claude", "sonnet", "auto").unwrap().id).unwrap();
    store.message(&early.id, "user", "First").unwrap();
    assert_eq!(store.session(&early.id).unwrap().sidebar_order, None);
    store.reorder_sessions(&[first.id.clone(), second.id.clone(), early.id.clone()]).unwrap();
    let draft = store.mark_draft(&store.create_session(&first.project_id, "codex", "gpt-5", "auto").unwrap().id).unwrap();
    assert_eq!(store.session(&draft.id).unwrap().sidebar_order, None, "drafts are not ranked");
    store.message(&draft.id, "user", "Build the thing").unwrap();
    assert_eq!(store.session(&draft.id).unwrap().sidebar_order, Some(0));
    assert_eq!(ids(&store), vec![draft.id.clone(), first.id.clone(), second.id.clone(), early.id.clone()]);
    // Reordering two other tasks keeps it on top instead of ranking it last.
    store.reorder_sessions(&[second.id.clone(), first.id.clone()]).unwrap();
    assert_eq!(ids(&store), vec![draft.id.clone(), second.id.clone(), first.id.clone(), early.id.clone()]);
}

#[test]
fn projects_list_by_name_and_carry_the_order_they_were_added() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let root = std::env::temp_dir().join(format!("pandacode-added-{}", id()));
    for name in ["zeta", "alpha", "mid"] { std::fs::create_dir_all(root.join(name)).unwrap(); }
    let added = ["zeta", "alpha", "mid"].map(|name| store.add_project(&root.join(name)).unwrap());
    assert!(added[0].added_order < added[1].added_order && added[1].added_order < added[2].added_order);
    let listed = store.projects().unwrap();
    assert_eq!(listed.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["alpha", "mid", "zeta"]);
    assert_eq!(listed.iter().find(|p| p.name == "zeta").unwrap().added_order, added[0].added_order);
    assert_eq!(store.project(&added[2].id).unwrap().added_order, added[2].added_order);
    let json = serde_json::to_value(&listed[0]).unwrap();
    assert!(json.get("addedOrder").is_some_and(|value| value.is_i64()));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn relinking_points_the_project_at_its_moved_folder() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let root = std::env::temp_dir().join(format!("pandacode-relink-{}", id()));
    std::fs::create_dir_all(root.join("before")).unwrap();
    std::fs::create_dir_all(root.join("after")).unwrap();
    let project = store.add_project(&root.join("before")).unwrap();
    let moved = store.relink_project(&project.id, &root.join("after")).unwrap();
    assert_eq!(moved.path, root.join("after").canonicalize().unwrap().to_string_lossy().to_string());
    // The project's label follows the folder's new name.
    assert_eq!(moved.name, "after");
    assert_eq!(store.project(&project.id).unwrap().path, moved.path);
    assert!(store.project_worktrees(&project.id).unwrap().is_empty());
    // Picking the folder the project already points at changes nothing.
    assert_eq!(store.relink_project(&project.id, &root.join("after")).unwrap().id, project.id);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn relinking_refuses_missing_taken_file_and_chat_folders() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let root = std::env::temp_dir().join(format!("pandacode-relink-{}", id()));
    std::fs::create_dir_all(root.join("one")).unwrap();
    std::fs::create_dir_all(root.join("two")).unwrap();
    let one = store.add_project(&root.join("one")).unwrap();
    let two = store.add_project(&root.join("two")).unwrap();
    // The folder was renamed away, so the chosen path does not resolve.
    assert!(store.relink_project(&one.id, &root.join("gone")).is_err());
    // Relative paths would resolve against the app's working directory.
    assert!(store.relink_project(&one.id, Path::new("two")).is_err());
    // The chats root itself is PandaCode's, not a project folder.
    assert!(store.relink_project(&one.id, &crate::chats::root()).is_err());
    // Another project already lives at the chosen folder.
    assert!(store.relink_project(&one.id, &root.join("two")).is_err());
    assert_eq!(store.project(&one.id).unwrap().path, one.path, "failed relinks keep the stored path");
    assert_eq!(store.project(&two.id).unwrap().path, two.path);
    // A file is not a folder.
    std::fs::write(root.join("file.txt"), "x").unwrap();
    assert!(store.relink_project(&one.id, &root.join("file.txt")).is_err());
    // Chat folders are PandaCode-managed and never relinked; the stored path is
    // inserted directly because add_project would refuse the missing folder.
    let chat_folder = crate::chats::root().join("chat-re1inktest");
    store.db.execute("INSERT INTO projects(id,name,path) VALUES ('chat-proj','Chat',?1)",
        params![chat_folder.to_string_lossy().to_string()]).unwrap();
    assert!(store.relink_project("chat-proj", &root.join("one")).is_err());
    // A project cannot be relinked into the chats root either.
    assert!(store.relink_project(&one.id, &crate::chats::root().join("chat-new")).is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_draft_open_during_a_reorder_stays_unranked_and_publishes_to_the_top() {
    let (store, first) = empty_session();
    let second = store.create_session(&first.project_id, "claude", "sonnet", "auto").unwrap();
    let draft = store.mark_draft(&store.create_session(&first.project_id, "codex", "gpt-5", "auto").unwrap().id).unwrap();
    // The draft is invisible, so a reorder must not rank it (it would then skip the publish rank).
    store.reorder_sessions(&[second.id.clone(), first.id.clone()]).unwrap();
    assert_eq!(store.session(&draft.id).unwrap().sidebar_order, None);
    assert_eq!(store.session(&second.id).unwrap().sidebar_order, Some(0));
    store.message(&draft.id, "user", "Now publish").unwrap();
    assert_eq!(store.session(&draft.id).unwrap().sidebar_order, Some(0));
    let ids = store.sessions().unwrap().into_iter().map(|task| task.id).collect::<Vec<_>>();
    assert_eq!(ids, vec![draft.id.clone(), second.id.clone(), first.id.clone()]);
}

#[test]
fn resume_links_harness_sessions_and_usage_links_include_the_current_id() {
    let (store, session) = empty_session();
    assert!(store.usage_links(&session.id).unwrap().is_empty(), "a fresh task has no harness sessions");
    store.resume(&session.id, "alpha").unwrap();
    store.resume(&session.id, "beta").unwrap();
    assert_eq!(store.usage_links(&session.id).unwrap(), vec!["alpha", "beta"]);
    // A task whose id arrived outside the run loop still reports through its links.
    store
        .db
        .execute("INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at) VALUES ('imported',?1,'Imported','claude','sonnet','auto',0,0,0)", [&session.project_id])
        .unwrap();
    store.resume("imported", "gamma").unwrap();
    assert_eq!(store.usage_links("imported").unwrap(), vec!["gamma"]);
    // Ids written without resume() (imports, forks) still count through the current resume id.
    store
        .db
        .execute("INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at,resume_id) VALUES ('forked',?1,'Forked','codex','gpt-5','auto',0,0,0,'direct-id')", [&session.project_id])
        .unwrap();
    assert_eq!(store.usage_links("forked").unwrap(), vec!["direct-id"]);
}

#[test]
fn new_task_drafts_stay_hidden_until_their_first_prompt() {
    let (store, listed) = empty_session();
    let draft = store.create_session(&listed.project_id, "codex", "gpt-5", "auto").unwrap();
    let draft = store.mark_draft(&draft.id).unwrap();
    assert!(draft.draft);
    let ids = |store: &Store| store.sessions().unwrap().into_iter().map(|task| task.id).collect::<Vec<_>>();
    assert_eq!(ids(&store), vec![listed.id.clone()]);
    assert!(store.session(&draft.id).unwrap().draft, "the open draft still loads by id");
    assert!(store.is_empty_draft(&draft.id).unwrap());
    // A reply or tool output alone does not publish it; the first prompt does.
    store.message(&draft.id, "assistant", "hello").unwrap();
    assert!(store.session(&draft.id).unwrap().draft);
    store.message(&draft.id, "user", "   ").unwrap();
    assert!(store.session(&draft.id).unwrap().draft);
    store.message(&draft.id, "user", "Build the thing").unwrap();
    let published = store.session(&draft.id).unwrap();
    assert!(!published.draft);
    assert!(published.created_at >= draft.created_at);
    assert!(!store.is_empty_draft(&draft.id).unwrap());
    assert_eq!(ids(&store).len(), 2);
    // Marking a task that already has history is refused.
    assert!(!store.mark_draft(&draft.id).unwrap().draft);
}

#[test]
fn usage_limits_record_resets_schedule_resumes_and_clear_on_new_work() {
    let (store, task) = empty_session();
    store.set_limited(&task.id, Some(1_791_013_800_000)).unwrap();
    let limited = store.session(&task.id).unwrap();
    assert!(limited.limited_at.is_some());
    assert_eq!(limited.limited_until, Some(1_791_013_800_000));
    assert!(store.set_resume_at_reset(&task.id, true).unwrap().resume_at_reset);
    assert!(!store.set_resume_at_reset(&task.id, false).unwrap().resume_at_reset);
    store.set_resume_at_reset(&task.id, true).unwrap();
    // Replies do not clear a limit; a new prompt is new work and does.
    store.message(&task.id, "assistant", "partial reply").unwrap();
    assert!(store.session(&task.id).unwrap().limited_at.is_some());
    store.message(&task.id, "user", "Continue").unwrap();
    let cleared = store.session(&task.id).unwrap();
    assert_eq!((cleared.limited_at, cleared.limited_until, cleared.resume_at_reset), (None, None, false));
    // An unknown reset cannot be scheduled, and absurd times are dropped.
    store.set_limited(&task.id, None).unwrap();
    assert!(store.set_resume_at_reset(&task.id, true).is_err());
    store.set_limited(&task.id, Some(i64::MAX)).unwrap();
    assert_eq!(store.session(&task.id).unwrap().limited_until, None);
    store.clear_limited(&task.id).unwrap();
    assert!(store.session(&task.id).unwrap().limited_at.is_none());
    assert!(store.set_resume_at_reset(&task.id, true).is_err(), "only a limited task can resume at reset");
}

#[test]
fn task_search_matches_titles_and_messages_within_the_project() {
    let (store, task) = empty_session();
    store.update(&task.id, Some("Fix the login redirect".into()), None, None, None).unwrap();
    let other = store.create_session(&task.project_id, "codex", "gpt-5", "full").unwrap();
    store.message(&other.id, "user", "Please make the billing page load 100% faster").unwrap();
    store.message(&other.id, "assistant", "I will profile the billing page first.").unwrap();
    let folder = std::env::temp_dir().join(format!("pandacode-search-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&folder).unwrap();
    let elsewhere = store.add_project(&folder).unwrap();
    assert_ne!(elsewhere.id, task.project_id);
    let foreign = store.create_session(&elsewhere.id, "codex", "gpt-5", "full").unwrap();
    store.message(&foreign.id, "user", "billing secrets").unwrap();
    let ids = |query: &str| store.search_tasks(&task.project_id, query, 20).unwrap().into_iter().map(|row| row["taskId"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!(ids("LOGIN"), vec![task.id.clone()]);
    let billing = store.search_tasks(&task.project_id, "billing", 20).unwrap();
    assert_eq!(billing.len(), 1, "other projects stay out of the results");
    assert!(billing[0]["excerpt"].as_str().unwrap().contains("billing page"));
    // LIKE wildcards are literal.
    assert_eq!(ids("100%"), vec![other.id.clone()]);
    assert!(ids("10_%").is_empty());
    assert!(store.search_tasks(&task.project_id, "  ", 20).is_err());
    std::fs::remove_dir_all(folder).unwrap();
}

#[test]
fn startup_discards_only_empty_drafts() {
    let (store, board_like) = empty_session();
    let empty = store.create_session(&board_like.project_id, "codex", "gpt-5", "auto").unwrap();
    store.mark_draft(&empty.id).unwrap();
    let replied = store.create_session(&board_like.project_id, "codex", "gpt-5", "auto").unwrap();
    store.mark_draft(&replied.id).unwrap();
    store.message(&replied.id, "assistant", "partial").unwrap();
    assert_eq!(store.discard_empty_drafts().unwrap(), 1);
    assert!(store.session(&empty.id).is_err());
    assert!(store.session(&replied.id).is_ok(), "a draft with saved history is kept");
    assert!(store.session(&board_like.id).is_ok(), "empty non-draft tasks, such as board tasks, are kept");
}

#[test]
fn sidebar_metadata_has_unpinned_unordered_defaults() {
    let (store, task) = empty_session();
    let saved = serde_json::to_value(store.session(&task.id).unwrap()).unwrap();
    assert_eq!(saved["pinned"], false);
    assert_eq!(saved["sidebarOrder"], serde_json::Value::Null);
}

#[test]
fn board_tasks_are_pending_without_starting_a_conversation() {
    let (store, source) = empty_session();
    let task = store
        .create_board_task(
            &source.project_id,
            "codex",
            "gpt-5",
            "plan",
            "  Build game  ",
            "  Add a board and timer.  ",
        )
        .unwrap();
    assert_eq!(task.title, "Build game");
    assert_eq!(task.task_description, "Add a board and timer.");
    assert_eq!(task.task_stage, "pending");
    assert_eq!(task.status, "idle");
    assert_eq!(task.mode, "plan");
    assert!(task.completed_at.is_none());
    assert!(store.messages(&task.id, None).unwrap().is_empty());
    let edited = store
        .update_task_details(&task.id, "Add leaderboard", "Rank the scores")
        .unwrap();
    assert_eq!(edited.task_description, "Rank the scores");
    assert!(store.messages(&task.id, None).unwrap().is_empty());
    let count = store.sessions().unwrap().len();
    for (provider, title, details) in [
        ("bad", "Valid", ""),
        ("codex", "  ", ""),
        ("codex", "Valid", &"x".repeat(crate::MESSAGE_LIMIT + 1)),
    ] {
        assert!(store
            .create_board_task(
                &source.project_id,
                provider,
                "default",
                "ask",
                title,
                details
            )
            .is_err());
    }
    assert_eq!(store.sessions().unwrap().len(), count);
    assert_eq!(serde_json::to_value(task).unwrap()["taskStage"], "pending");
}

#[test]
fn task_lists_bound_description_previews_without_truncating_details_or_start_prompts() {
    let (store, source) = empty_session();
    let description = "λ".repeat(8_000);
    let task = store
        .create_board_task(
            &source.project_id,
            "codex",
            "default",
            "ask",
            "Long specification",
            &description,
        )
        .unwrap();
    let preview = store
        .sessions()
        .unwrap()
        .into_iter()
        .find(|item| item.id == task.id)
        .unwrap();
    assert_eq!(preview.task_description.chars().count(), 512);
    assert_eq!(
        store.session(&task.id).unwrap().task_description,
        description
    );
    // Start reads the full task through session(), independently of the
    // shortened board metadata returned to the frontend.
    let prompt = store.session(&task.id).unwrap().task_description;
    store.begin_task_turn(&task.id, &prompt).unwrap();
    assert_eq!(
        store.messages(&task.id, None).unwrap()[0].content,
        description
    );
}

#[test]
fn configure_empty_task_can_switch_provider_and_preserves_permissions() {
    let (store, session) = empty_session();
    store
        .update(
            &session.id,
            Some("Saved title".into()),
            Some(true),
            None,
            None,
        )
        .unwrap();
    store
        .db
        .execute(
            "UPDATE sessions SET updated_at=0 WHERE id=?1",
            [&session.id],
        )
        .unwrap();
    let before = store.session(&session.id).unwrap();
    let updated = store
        .configure(&session.id, "codex", "gpt-5.6-sol", None)
        .unwrap();
    assert_eq!(updated.provider, "codex");
    assert_eq!(updated.model, "gpt-5.6-sol");
    assert_eq!(updated.mode, before.mode);
    assert_eq!(updated.resume_id, None);
    assert_eq!(updated.id, before.id);
    assert_eq!(updated.project_id, before.project_id);
    assert_eq!(updated.title, before.title);
    assert_eq!(updated.archived, before.archived);
    assert_eq!(updated.status, before.status);
    assert_eq!(updated.created_at, before.created_at);
    assert!(updated.updated_at > before.updated_at);
}

#[test]
fn configure_empty_task_project_switch_preserves_identity_and_survives_reopen() {
    let dir = std::env::temp_dir().join(format!("pandacode-project-switch-{}", id()));
    std::fs::create_dir_all(dir.join("destination")).unwrap();
    let path = dir.join("store.db");
    let expected;
    {
        let store = Store::open(&path).unwrap();
        let source = store.add_project(&dir).unwrap();
        let destination = store.add_project(&dir.join("destination")).unwrap();
        let task = store
            .create_session(&source.id, "claude", "sonnet", "auto")
            .unwrap();
        store
            .update(&task.id, Some("Draft task".into()), None, None, None)
            .unwrap();
        store
            .db
            .execute("UPDATE sessions SET updated_at=0 WHERE id=?1", [&task.id])
            .unwrap();
        let before = store.session(&task.id).unwrap();
        let moved = store
            .configure(&task.id, "claude", "sonnet", Some(&destination.id))
            .unwrap();
        assert_eq!(moved.project_id, destination.id);
        assert!(moved.updated_at > before.updated_at);
        let mut prior = serde_json::to_value(before).unwrap();
        prior["projectId"] = destination.id.into();
        prior["updatedAt"] = moved.updated_at.into();
        expected = serde_json::to_value(&moved).unwrap();
        assert_eq!(
            expected, prior,
            "Only project and modification time should change"
        );
        assert!(store.messages(&task.id, None).unwrap().is_empty());
    }
    {
        let store = Store::open(&path).unwrap();
        assert_eq!(
            serde_json::to_value(store.sessions().unwrap().remove(0)).unwrap(),
            expected
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn configure_project_change_rejects_any_history_and_resume_atomically() {
    for role in ["user", "assistant", "tool", "status", "error", "resume"] {
        let (store, task) = empty_session();
        let destination = store.add_project(Path::new("/")).unwrap();
        if role == "resume" {
            store.resume(&task.id, "remote-task").unwrap();
        } else {
            store.message(&task.id, role, "Saved activity").unwrap();
        }
        let before = serde_json::to_value(store.session(&task.id).unwrap()).unwrap();
        assert!(
            store
                .configure(&task.id, "claude", "opus", Some(&destination.id))
                .is_err(),
            "History kind {role} must prevent moving"
        );
        assert_eq!(
            serde_json::to_value(store.session(&task.id).unwrap()).unwrap(),
            before
        );
        let same = store
            .configure(&task.id, "claude", "opus", Some(&task.project_id))
            .unwrap();
        assert_eq!(same.project_id, task.project_id);
        assert_eq!(
            same.model, "opus",
            "Existing tasks can still change models within their project"
        );
    }
}

#[test]
fn configure_project_change_checks_history_outside_current_page() {
    let (store, task) = empty_session();
    let destination = store.add_project(Path::new("/")).unwrap();
    store.message(&task.id, "user", "Original prompt").unwrap();
    for _ in 0..100 {
        store.message(&task.id, "tool", "Tool completed").unwrap();
    }
    assert!(store
        .messages(&task.id, None)
        .unwrap()
        .iter()
        .all(|m| m.role == "tool"));
    let before = serde_json::to_value(store.session(&task.id).unwrap()).unwrap();
    assert!(store
        .configure(&task.id, "claude", "opus", Some(&destination.id))
        .is_err());
    assert_eq!(
        serde_json::to_value(store.session(&task.id).unwrap()).unwrap(),
        before
    );
}

#[test]
fn configure_project_change_rejects_active_task_without_messages() {
    for status in ["running", "waiting"] {
        let (store, task) = empty_session();
        let destination = store.add_project(Path::new("/")).unwrap();
        store.status(&task.id, status).unwrap();
        let before = serde_json::to_value(store.session(&task.id).unwrap()).unwrap();
        assert!(store
            .configure(&task.id, "claude", "opus", Some(&destination.id))
            .is_err());
        assert_eq!(
            serde_json::to_value(store.session(&task.id).unwrap()).unwrap(),
            before
        );
    }
}

#[test]
fn configure_invalid_project_cannot_partially_change_harness_or_model() {
    let (store, task) = empty_session();
    let before = serde_json::to_value(store.session(&task.id).unwrap()).unwrap();
    for project in ["missing", ""] {
        assert!(store
            .configure(&task.id, "codex", "default", Some(project))
            .is_err());
        assert_eq!(
            serde_json::to_value(store.session(&task.id).unwrap()).unwrap(),
            before
        );
    }
    let destination = store.add_project(Path::new("/")).unwrap();
    assert!(store
        .configure(&task.id, "unknown", "default", Some(&destination.id))
        .is_err());
    assert!(store
        .configure(&task.id, "codex", &"x".repeat(201), Some(&destination.id))
        .is_err());
    assert_eq!(
        serde_json::to_value(store.session(&task.id).unwrap()).unwrap(),
        before
    );
}

#[test]
fn configure_provider_change_preserves_history_outside_current_page() {
    let (store, session) = empty_session();
    store.message(&session.id, "user", "Original prompt").unwrap();
    store.message(&session.id, "assistant", "Keep the exact code").unwrap();
    store.resume(&session.id, "old-native-id").unwrap();
    for _ in 0..100 { store.message(&session.id, "tool", "Tool completed").unwrap(); }
    let updated = store.configure(&session.id, "kimi", "default", None).unwrap();
    assert_eq!(updated.provider, "kimi");
    assert_eq!(updated.project_id, session.project_id);
    assert!(updated.resume_id.is_none());
    assert!(crate::context_recovery::pending(&store, &updated).unwrap());
    let (prompt, through) = crate::context_recovery::prepare(&store, &updated, "Continue").unwrap();
    assert!(through.is_some());
    assert!(prompt.contains("Original prompt"));
    assert!(prompt.contains("Keep the exact code"));
    assert!(!prompt.contains("Tool completed"));
    assert_eq!(store.messages(&session.id, None).unwrap().last().unwrap().role, "handoff");
    store.resume(&session.id, "new-native-id").unwrap();
    assert!(crate::context_recovery::pending(&store, &store.session(&session.id).unwrap()).unwrap());
}

#[test]
fn configure_provider_change_clears_resume_without_inventing_missing_history() {
    let (store, session) = empty_session();
    store.resume(&session.id, "provider-session-1").unwrap();
    let updated = store.configure(&session.id, "codex", "default", None).unwrap();
    assert!(updated.resume_id.is_none());
    assert_eq!(store.messages(&session.id, None).unwrap()[0].role, "handoff");
    assert!(!crate::context_recovery::pending(&store, &updated).unwrap());
}

#[test]
fn configure_same_provider_can_change_model_with_history_and_resume() {
    let (store, session) = empty_session();
    store.resume(&session.id, "provider-session-1").unwrap();
    store
        .message(&session.id, "user", "Original prompt")
        .unwrap();
    let updated = store
        .configure(&session.id, "claude", "opus", None)
        .unwrap();
    assert_eq!(updated.model, "opus");
    assert_eq!(updated.mode, "auto");
    assert_eq!(updated.resume_id.as_deref(), Some("provider-session-1"));
    assert_eq!(
        store.messages(&session.id, None).unwrap()[0].content,
        "Original prompt"
    );
}

#[test]
fn configure_rejects_invalid_provider_model_and_missing_task_atomically() {
    let (store, session) = empty_session();
    let before = serde_json::to_value(store.session(&session.id).unwrap()).unwrap();
    assert!(store
        .configure(&session.id, "shell", "default", None)
        .is_err());
    assert!(store
        .configure(&session.id, "codex", &"x".repeat(201), None)
        .is_err());
    assert!(store
        .configure("missing", "claude", "sonnet", None)
        .is_err());
    assert_eq!(
        serde_json::to_value(store.session(&session.id).unwrap()).unwrap(),
        before
    );
    assert!(store
        .configure(&session.id, "claude", &"x".repeat(200), None)
        .is_ok());
}

#[test]
fn rejects_unknown_providers_and_permission_modes() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let p = store.add_project(&std::env::temp_dir()).unwrap();
    assert!(store.create_session(&p.id, "shell", "", "ask").is_err());
    assert!(store
        .create_session(&p.id, "codex", "", "dangerously-bypass")
        .is_err());
    assert!(store.messages("missing", None).is_err());
}

#[test]
fn narrow_session_lookups_keep_the_missing_task_error() {
    let (store, task) = empty_session();
    for result in [
        store.messages("missing", None).map(|_| ()),
        store.subagents("missing").map(|_| ()),
        store.subagent_rows("missing").map(|_| ()),
        store.worktree_attachable("missing").map(|_| ()),
        store.begin_goal_operation("missing"),
        store.record_goal("missing", None),
        store.provider_at_message("missing", 0).map(|_| ()),
        store.workspace_root(&task.project_id, Some("missing")).map(|_| ()),
    ] {
        assert_eq!(result.unwrap_err(), "Conversation not found.");
    }
    assert_eq!(store.workspace_root("missing", Some(&task.id)).unwrap_err(), "Project not found.");
    assert!(store.worktree_attachable(&task.id).unwrap());
    store.message(&task.id, "user", "hello").unwrap();
    assert!(!store.worktree_attachable(&task.id).unwrap(), "a task with history cannot be converted");
    assert_eq!(store.provider_at_message(&task.id, 0).unwrap(), "claude");
}

#[test]
fn task_search_keeps_title_matches_order_excerpts_and_limit() {
    let (store, first) = empty_session();
    let project = first.project_id.clone();
    store.update(&first.id, Some("Deploy notes".into()), None, None, None).unwrap();
    let second = store.create_session(&project, "claude", "sonnet", "auto").unwrap();
    store.message(&second.id, "user", "an old deploy question").unwrap();
    store.message(&second.id, "assistant", "the newest deploy answer").unwrap();
    store.message(&second.id, "tool", "deploy tool output is not searched").unwrap();
    let third = store.create_session(&project, "claude", "sonnet", "auto").unwrap();
    store.message(&third.id, "tool", "deploy").unwrap();
    let draft = store.create_session(&project, "claude", "sonnet", "auto").unwrap();
    store.mark_draft(&draft.id).unwrap();
    store.update(&draft.id, Some("deploy draft".into()), None, None, None).unwrap();
    for (at, sid) in [(1, &first.id), (2, &second.id), (3, &third.id), (4, &draft.id)] {
        store.db.execute("UPDATE sessions SET updated_at=?2 WHERE id=?1", params![sid, at]).unwrap();
    }
    let rows = store.search_tasks(&project, "DEPLOY", 20).unwrap();
    let found: Vec<_> = rows.iter().map(|row| row["taskId"].as_str().unwrap()).collect();
    assert_eq!(found, vec![second.id.as_str(), first.id.as_str()], "newest first; tool rows and drafts are not searched");
    assert_eq!(rows[0]["excerpt"], "the newest deploy answer");
    assert_eq!(rows[0]["updatedAt"], 2);
    assert!(rows[1]["excerpt"].is_null(), "a title-only match has no excerpt");
    assert_eq!(store.search_tasks(&project, "deploy", 1).unwrap().len(), 1);
}

#[test]
fn links_attach_to_one_task_and_to_a_listing() {
    let (store, task) = empty_session();
    let other = store.create_session(&task.project_id, "claude", "sonnet", "auto").unwrap();
    let link = |number: i64| TaskLink { kind: String::new(), number, url: format!("https://github.com/o/r/pull/{number}"), title: format!("#{number}"), state: "open".into(), checked_at: 0 };
    store.set_task_link(&task.id, "pull", Some(&link(7))).unwrap();
    store.set_task_link(&task.id, "issue", Some(&link(3))).unwrap();
    store.set_task_link(&other.id, "issue", Some(&link(9))).unwrap();
    let one = store.session(&task.id).unwrap();
    assert_eq!((one.pull_request.as_ref().unwrap().number, one.issue.as_ref().unwrap().number), (7, 3));
    let listing = store.sessions().unwrap();
    let by_id = |sid: &str| listing.iter().find(|s| s.id == sid).unwrap();
    assert_eq!(by_id(&task.id).pull_request.as_ref().unwrap().number, 7);
    assert_eq!(by_id(&other.id).issue.as_ref().unwrap().number, 9);
    assert!(by_id(&other.id).pull_request.is_none());
    assert_eq!(store.set_task_link("missing", "pull", Some(&link(1))).unwrap_err(), "Conversation not found.");
    store.update_link_states(&task.project_id, &[("pull".into(), 7, "merged".into(), String::new())]).unwrap();
    let merged = store.session(&task.id).unwrap().pull_request.unwrap();
    assert_eq!((merged.state.as_str(), merged.title.as_str()), ("merged", "#7"));
}

#[test]
fn reorder_writes_only_ranks_that_change() {
    let (store, first) = empty_session();
    let second = store.create_session(&first.project_id, "claude", "sonnet", "auto").unwrap();
    let third = store.create_session(&first.project_id, "claude", "sonnet", "auto").unwrap();
    store.reorder_sessions(&[first.id.clone(), second.id.clone(), third.id.clone()]).unwrap();
    store.db.execute_batch("CREATE TEMP TABLE rank_writes(id TEXT); CREATE TEMP TRIGGER count_rank_writes AFTER UPDATE OF sidebar_order ON main.sessions BEGIN INSERT INTO rank_writes VALUES(NEW.id); END;").unwrap();
    let listed = store.reorder_sessions(&[third.id.clone(), second.id.clone(), first.id.clone()]).unwrap();
    let order: Vec<_> = listed.iter().map(|s| s.id.clone()).collect();
    assert_eq!(order, vec![third.id.clone(), second.id.clone(), first.id.clone()]);
    let mut written: Vec<String> = store.db.prepare("SELECT id FROM rank_writes").unwrap().query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    written.sort();
    let mut expected = vec![first.id.clone(), third.id.clone()];
    expected.sort();
    assert_eq!(written, expected, "the middle task kept its rank");
}

#[test]
fn approval_behavior_cannot_change_during_a_running_turn() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let session = store
        .create_session(&project.id, "codex", "default", "ask")
        .unwrap();
    for status in ["running", "waiting"] {
        store.status(&session.id, status).unwrap();
        assert!(store
            .update(
                &session.id,
                Some("New title".into()),
                None,
                None,
                Some("full".into())
            )
            .unwrap_err()
            .contains("Stop the agent"));
        let unchanged = store.session(&session.id).unwrap();
        assert_eq!(unchanged.mode, "ask");
        assert_eq!(unchanged.title, "New conversation");
        store
            .update(&session.id, Some("Renamed task".into()), None, None, None)
            .unwrap();
        store
            .update(
                &session.id,
                Some("New conversation".into()),
                None,
                None,
                None,
            )
            .unwrap();
    }
    store.status(&session.id, "idle").unwrap();
    store
        .update(&session.id, None, None, None, Some("plan".into()))
        .unwrap();
    assert_eq!(store.session(&session.id).unwrap().mode, "plan");
    assert!(store
        .update(&session.id, None, None, None, Some("invalid".into()))
        .is_err());
    assert_eq!(store.session(&session.id).unwrap().mode, "plan");
}
