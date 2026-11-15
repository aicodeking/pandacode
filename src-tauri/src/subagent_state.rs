//! Per-run snapshots keep child streaming off SQLite's shared write lock.
use crate::{
    providers::{AgentEvent, SubagentActivity},
    storage::Store,
    Result,
};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

pub(crate) const EMIT_INTERVAL: Duration = Duration::from_millis(150);

#[derive(Default)]
pub(crate) struct SubagentState {
    entries: HashMap<String, Entry>,
    next_number: usize,
}

struct Entry {
    activity: SubagentActivity,
    last_saved: Option<Instant>,
    saved_status: String,
    last_emitted: Option<Instant>,
    emitted_status: String,
    emitted_tools: usize,
    emitted_tool_statuses: Vec<(String, String)>,
    dirty_emit: bool,
    seq: u64,
    number: usize,
}

/// How much of a child's prompt and response a list row carries. One more than the 1024 bytes
/// `pandacode_list_subagents` shows, so a longer text still reads as cut there.
pub(crate) const PREVIEW_CHARS: i64 = 1025;

/// One child in a task's list: everything but its tools and the rest of its text. The webview
/// asks for the full snapshot (`get_subagent`) when a row is opened.
#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRow {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub prompt: String,
    pub status: String,
    pub response: String,
    pub tool_count: i64,
    pub started_at: i64,
    pub updated_at: i64,
}

impl From<&SubagentActivity> for SubagentRow {
    fn from(activity: &SubagentActivity) -> Self {
        let preview = |text: &str| text.chars().take(PREVIEW_CHARS as usize).collect();
        Self {
            id: activity.id.clone(),
            parent_id: activity.parent_id.clone(),
            name: activity.name.clone(),
            prompt: preview(&activity.prompt),
            status: activity.status.clone(),
            response: preview(&activity.response),
            tool_count: activity.tools.len() as i64,
            started_at: activity.started_at,
            updated_at: activity.updated_at,
        }
    }
}

/// Launcher metadata deliberately excludes responses, prompts, and tool output.
pub(crate) struct ActiveSummary {
    pub id: String,
    pub name: String,
    pub status: String,
    pub updated_at: i64,
}

fn running(status: &str) -> bool {
    matches!(status, "running" | "waiting")
}

fn tool_statuses(activity: &SubagentActivity) -> Vec<(String, String)> {
    activity
        .tools
        .iter()
        .map(|tool| (tool.id.clone(), tool.status.clone()))
        .collect()
}

fn tool_statuses_match(emitted: &[(String, String)], activity: &SubagentActivity) -> bool {
    emitted.len() == activity.tools.len()
        && emitted
            .iter()
            .zip(&activity.tools)
            .all(|((id, status), tool)| id == &tool.id && status == &tool.status)
}

fn payload(entry: &Entry) -> Result<serde_json::Value> {
    let mut value = serde_json::to_value(&entry.activity).map_err(|error| error.to_string())?;
    if let Some(object) = value.as_object_mut() {
        object.insert("seq".into(), serde_json::Value::from(entry.seq));
    }
    Ok(value)
}

impl SubagentState {
    /// Updates the live child snapshot and checkpoints durability. Returns `Ok(true)` when
    /// `event.data` was populated for immediate window emission (first sighting, non-running
    /// settlement, status/tool-count/tool-status transition, or `>= 150 ms` since the last emit),
    /// or `Ok(false)` when back-to-back streaming updates were coalesced in memory without JSON
    /// re-serialization.
    pub(crate) fn record(
        &mut self,
        store: &Mutex<Store>,
        run_id: &str,
        event: &mut AgentEvent,
    ) -> Result<bool> {
        let mut activity: SubagentActivity =
            serde_json::from_value(event.data.take().ok_or("Subagent snapshot is missing.")?)
                .map_err(|error| error.to_string())?;
        activity.id = format!("{run_id}:{}", activity.id);
        activity.parent_id = activity.parent_id.map(|id| format!("{run_id}:{id}"));
        for tool in &mut activity.tools {
            tool.id = format!("{}:{}", activity.id, tool.id);
        }
        let first_sighting = !self.entries.contains_key(&activity.id);
        if first_sighting {
            self.next_number += 1;
        }
        let number = self.next_number;
        let entry = self
            .entries
            .entry(activity.id.clone())
            .or_insert_with(|| Entry {
                activity: activity.clone(),
                last_saved: None,
                saved_status: String::new(),
                last_emitted: None,
                emitted_status: String::new(),
                emitted_tools: 0,
                emitted_tool_statuses: Vec::new(),
                dirty_emit: false,
                seq: 0,
                number,
            });
        entry.activity = activity;
        entry.seq += 1;
        let now = Instant::now();
        let should_emit = first_sighting
            || !running(&entry.activity.status)
            || entry.emitted_status != entry.activity.status
            || entry.emitted_tools != entry.activity.tools.len()
            || !tool_statuses_match(&entry.emitted_tool_statuses, &entry.activity)
            || entry
                .last_emitted
                .is_none_or(|emitted| now.duration_since(emitted) >= EMIT_INTERVAL);
        if should_emit {
            event.data = Some(payload(entry)?);
            entry.last_emitted = Some(now);
            entry.emitted_status.clone_from(&entry.activity.status);
            entry.emitted_tools = entry.activity.tools.len();
            entry.emitted_tool_statuses = tool_statuses(&entry.activity);
            entry.dirty_emit = false;
        } else {
            entry.dirty_emit = true;
        }
        // First sighting and lifecycle changes are durable immediately. Live
        // text/tools overwrite one in-memory snapshot and checkpoint at 1 Hz.
        if entry
            .last_saved
            .is_none_or(|saved| saved.elapsed() >= Duration::from_secs(1))
            || entry.saved_status != entry.activity.status
        {
            store
                .lock()
                .map_err(|error| error.to_string())?
                .save_subagent(&event.session_id, &entry.activity)?;
            entry.last_saved = Some(Instant::now());
            entry.saved_status.clone_from(&entry.activity.status);
        }
        Ok(should_emit)
    }

    pub(crate) fn has_dirty(&self) -> bool {
        self.entries.values().any(|entry| entry.dirty_emit)
    }

    pub(crate) fn flush_due(&mut self, session_id: &str, force: bool) -> Result<Vec<AgentEvent>> {
        let mut entries: Vec<_> = self
            .entries
            .values_mut()
            .filter(|entry| {
                entry.dirty_emit
                    && (force || entry.last_emitted.is_none_or(|t| t.elapsed() >= EMIT_INTERVAL))
            })
            .collect();
        entries.sort_by_key(|entry| entry.number);
        let now = Instant::now();
        let mut events = Vec::with_capacity(entries.len());
        for entry in entries {
            let mut ev = crate::event(session_id, "subagent", "");
            ev.data = Some(payload(entry)?);
            entry.dirty_emit = false;
            entry.last_emitted = Some(now);
            entry.emitted_status.clone_from(&entry.activity.status);
            entry.emitted_tools = entry.activity.tools.len();
            entry.emitted_tool_statuses = tool_statuses(&entry.activity);
            events.push(ev);
        }
        Ok(events)
    }

    pub(crate) fn contains(&self, id: &str) -> bool {
        self.entries.contains_key(id)
    }

    pub(crate) fn get(&self, id: &str) -> Option<SubagentActivity> {
        self.entries.get(id).map(|entry| entry.activity.clone())
    }

    pub(crate) fn active_summaries(&self) -> Vec<ActiveSummary> {
        let mut entries: Vec<_> = self
            .entries
            .values()
            .filter(|entry| running(&entry.activity.status))
            .collect();
        entries.sort_by_key(|entry| entry.number);
        entries
            .into_iter()
            .map(|entry| {
                let name = entry.activity.name.trim();
                let name = if name.is_empty()
                    || name.contains(['/', '\\'])
                    || name.eq_ignore_ascii_case("agent")
                    || name.eq_ignore_ascii_case("subagent")
                {
                    format!("#{}", entry.number)
                } else {
                    name.chars().take(160).collect()
                };
                ActiveSummary {
                    id: entry.activity.id.clone(),
                    name,
                    status: entry.activity.status.clone(),
                    updated_at: entry.activity.updated_at,
                }
            })
            .collect()
    }

    pub(crate) fn merge_history(&self, history: Vec<SubagentActivity>) -> Vec<SubagentActivity> {
        let mut combined: HashMap<String, SubagentActivity> = history
            .into_iter()
            .map(|activity| (activity.id.clone(), activity))
            .collect();
        combined.extend(
            self.entries
                .iter()
                .map(|(id, entry)| (id.clone(), entry.activity.clone())),
        );
        let mut activities: Vec<_> = combined.into_values().collect();
        activities.sort_by(|a, b| {
            running(&b.status)
                .cmp(&running(&a.status))
                .then_with(|| b.updated_at.cmp(&a.updated_at))
                .then_with(|| a.id.cmp(&b.id))
        });
        activities
    }

    /// `merge_history` for list rows: live work wins, and no snapshot is copied whole.
    pub(crate) fn merge_rows(&self, history: Vec<SubagentRow>) -> Vec<SubagentRow> {
        let mut combined: HashMap<String, SubagentRow> = history.into_iter().map(|row| (row.id.clone(), row)).collect();
        combined.extend(self.entries.iter().map(|(id, entry)| (id.clone(), SubagentRow::from(&entry.activity))));
        let mut rows: Vec<_> = combined.into_values().collect();
        rows.sort_by(|a, b| {
            running(&b.status)
                .cmp(&running(&a.status))
                .then_with(|| b.updated_at.cmp(&a.updated_at))
                .then_with(|| a.id.cmp(&b.id))
        });
        rows
    }

    pub(crate) fn finish(
        &mut self,
        store: &Store,
        session_id: &str,
        status: &str,
    ) -> (Vec<SubagentActivity>, Result<()>) {
        let mut changed = Vec::new();
        let mut first_error = None;
        for entry in self.entries.values_mut() {
            let child_open = running(&entry.activity.status);
            // A settled child may never have reported its last tool's result.
            let tool_open = entry.activity.tools.iter().any(|tool| running(&tool.status));
            if child_open || tool_open {
                if child_open {
                    entry.activity.status = status.into();
                }
                entry.activity.updated_at = crate::storage::now();
                for tool in &mut entry.activity.tools {
                    if running(&tool.status) {
                        tool.status = "failed".into();
                    }
                }
                entry.dirty_emit = false;
                changed.push(entry.activity.clone());
            } else if entry.dirty_emit {
                entry.dirty_emit = false;
                changed.push(entry.activity.clone());
            }
            // Always flush: the final text snapshot may still be inside the
            // checkpoint interval even when the child already reported done.
            if let Err(error) = store.save_subagent(session_id, &entry.activity) {
                first_error.get_or_insert(error);
            }
        }
        if let Err(error) = store.finish_subagents(session_id, status) {
            first_error.get_or_insert(error);
        }
        // The run has ended even if its final database write failed. Return
        // settlement snapshots independently so the live viewer also stops.
        (changed, first_error.map_or(Ok(()), Err))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::ToolActivity;

    fn task(store: &Store) -> String {
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        store
            .create_session(&project.id, "codex", "default", "ask")
            .unwrap()
            .id
    }

    fn child(id: &str, status: &str) -> SubagentActivity {
        SubagentActivity {
            id: id.into(),
            parent_id: None,
            name: "Read project".into(),
            prompt: "Find the build command".into(),
            status: status.into(),
            response: "Reading".into(),
            tools: vec![ToolActivity {
                id: "read".into(),
                name: "Read".into(),
                status: "running".into(),
                input: "README.md".into(),
                output: String::new(),
                write_paths: None,
            }],
            started_at: 100,
            updated_at: 100,
        }
    }

    fn record(
        state: &mut SubagentState,
        store: &Mutex<Store>,
        session_id: &str,
        run: &str,
        child: SubagentActivity,
    ) -> SubagentActivity {
        let scoped_id = format!("{run}:{}", child.id);
        let mut event = crate::event(session_id, "subagent", "");
        event.data = Some(serde_json::to_value(child).unwrap());
        if state.record(store, run, &mut event).unwrap() {
            serde_json::from_value(event.data.unwrap()).unwrap()
        } else {
            assert!(event.data.is_none());
            state.get(&scoped_id).unwrap()
        }
    }

    #[test]
    fn active_metadata_excludes_settled_children_and_uses_stable_safe_names() {
        let store = Mutex::new(Store::open(std::path::Path::new(":memory:")).unwrap());
        let sid = task(&store.lock().unwrap());
        let mut state = SubagentState::default();
        let mut first = child("first", "running");
        first.name = "/private/tmp/worker.jsonl".into();
        first.response = "x".repeat(500_000);
        record(&mut state, &store, &sid, "run", first.clone());
        let mut second = child("second", "waiting");
        second.name = "Design audit".into();
        record(&mut state, &store, &sid, "run", second);
        let rows = state.active_summaries();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "#1");
        assert_eq!(rows[1].name, "Design audit");
        assert!(state.contains("run:first"));
        assert!(!state.contains("another:first"));
        first.status = "completed".into();
        record(&mut state, &store, &sid, "run", first);
        let mut third = child("third", "running");
        third.name = "agent".into();
        record(&mut state, &store, &sid, "run", third);
        let rows = state.active_summaries();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "run:second");
        assert_eq!(rows[1].name, "#3");
    }

    #[test]
    fn ids_parents_and_tools_are_scoped_to_the_run_and_history_isolated_by_task() {
        let store = Mutex::new(Store::open(std::path::Path::new(":memory:")).unwrap());
        let sid = task(&store.lock().unwrap());
        let other_sid = task(&store.lock().unwrap());
        let mut state = SubagentState::default();
        let mut activity = child("worker", "completed");
        activity.parent_id = Some("parent".into());
        let saved = record(&mut state, &store, &sid, "first", activity.clone());
        assert_eq!(saved.id, "first:worker");
        assert_eq!(saved.parent_id.as_deref(), Some("first:parent"));
        assert_eq!(saved.tools[0].id, "first:worker:read");
        record(
            &mut SubagentState::default(),
            &store,
            &sid,
            "second",
            activity.clone(),
        );
        record(
            &mut SubagentState::default(),
            &store,
            &other_sid,
            "third",
            activity,
        );
        let db = store.lock().unwrap();
        assert_eq!(db.subagents(&sid).unwrap().len(), 2);
        assert_eq!(db.subagents(&other_sid).unwrap()[0].id, "third:worker");
        assert!(db.messages(&sid, None).unwrap().is_empty());
        assert!(db.subagents("missing").is_err());
    }

    #[test]
    fn live_snapshots_override_history_without_writing_for_every_chunk() {
        let store = Mutex::new(Store::open(std::path::Path::new(":memory:")).unwrap());
        let sid = task(&store.lock().unwrap());
        let mut state = SubagentState::default();
        let mut activity = child("worker", "running");
        record(&mut state, &store, &sid, "run", activity.clone());
        let changes = store.lock().unwrap().db.total_changes();
        for n in 0..200 {
            activity.response = format!("Read {n} lines");
            activity.updated_at += 1;
            record(&mut state, &store, &sid, "run", activity.clone());
        }
        let history = store.lock().unwrap().subagents(&sid).unwrap();
        assert_eq!(store.lock().unwrap().db.total_changes(), changes);
        assert_eq!(history[0].response, "Reading");
        assert_eq!(state.merge_history(history)[0].response, "Read 199 lines");
        state.entries.get_mut("run:worker").unwrap().last_saved =
            Some(Instant::now() - Duration::from_secs(2));
        activity.response = "Checkpoint".into();
        record(&mut state, &store, &sid, "run", activity.clone());
        assert_eq!(
            store.lock().unwrap().subagents(&sid).unwrap()[0].response,
            "Checkpoint"
        );
        activity.status = "completed".into();
        activity.response = "Final answer".into();
        record(&mut state, &store, &sid, "run", activity.clone());
        assert_eq!(
            store.lock().unwrap().subagents(&sid).unwrap()[0].response,
            "Final answer"
        );
        activity.response = "Final answer with last suffix".into();
        record(&mut state, &store, &sid, "run", activity);
        let db = store.lock().unwrap();
        let (changed, saved) = state.finish(&db, &sid, "stopped");
        saved.unwrap();
        assert_eq!(changed[0].status, "completed", "only its open tool settles");
        assert_eq!(
            db.subagents(&sid).unwrap()[0].response,
            "Final answer with last suffix"
        );
    }

    #[test]
    fn finishing_settles_only_unfinished_children_and_preserves_their_work() {
        for status in ["stopped", "failed"] {
            let store = Mutex::new(Store::open(std::path::Path::new(":memory:")).unwrap());
            let sid = task(&store.lock().unwrap());
            let other_sid = task(&store.lock().unwrap());
            let mut state = SubagentState::default();
            record(&mut state, &store, &sid, "run", child("active", "running"));
            record(
                &mut state,
                &store,
                &sid,
                "run",
                child("approval", "waiting"),
            );
            record(&mut state, &store, &sid, "run", child("done", "completed"));
            record(
                &mut SubagentState::default(),
                &store,
                &other_sid,
                "other",
                child("worker", "running"),
            );
            let db = store.lock().unwrap();
            let (changed, saved) = state.finish(&db, &sid, status);
            saved.unwrap();
            assert_eq!(changed.len(), 3);
            for activity in &changed {
                let expected = if activity.id == "run:done" { "completed" } else { status };
                assert_eq!(activity.status, expected);
                assert_eq!(activity.response, "Reading");
                assert_eq!(activity.tools[0].status, "failed", "no spinner survives the run");
            }
            let history = db.subagents(&sid).unwrap();
            let done = history.iter().find(|a| a.id == "run:done").unwrap();
            assert_eq!(done.status, "completed");
            assert_eq!(done.tools[0].status, "failed", "saved settled too");
            assert_eq!(db.subagents(&other_sid).unwrap()[0].status, "running");
        }
    }

    #[test]
    fn restart_retains_history_and_recovers_children_even_if_parent_status_was_saved_first() {
        let dir = std::env::temp_dir().join(format!(
            "pandacode-subagent-history-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("history.sqlite");
        let sid;
        {
            let store = Store::open(&path).unwrap();
            sid = task(&store);
            store
                .save_subagent(&sid, &child("active", "running"))
                .unwrap();
            store
                .save_subagent(&sid, &child("waiting", "waiting"))
                .unwrap();
            store
                .save_subagent(&sid, &child("done", "completed"))
                .unwrap();
            for _ in 0..105 {
                store.message(&sid, "assistant", "Parent response").unwrap();
            }
            assert_eq!(store.messages(&sid, None).unwrap().len(), 100);
        }
        {
            let store = Store::open(&path).unwrap();
            let history = store.subagents(&sid).unwrap();
            assert_eq!(history.len(), 3);
            assert_eq!(history.iter().filter(|a| a.status == "stopped").count(), 2);
            assert!(history
                .iter()
                .filter(|a| a.status == "stopped")
                .all(|a| a.tools[0].status == "failed"));
            assert_eq!(
                history.iter().find(|a| a.id == "done").unwrap().status,
                "completed"
            );
            assert!(history.iter().all(|a| a.response == "Reading"));
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn history_keeps_every_child_and_cascades_with_their_task() {
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let sid = task(&store);
        store
            .save_subagent(&sid, &child("still-active", "running"))
            .unwrap();
        for n in 0..80 {
            let mut activity = child(&format!("done-{n}"), "completed");
            activity.updated_at = 1000 + n;
            store.save_subagent(&sid, &activity).unwrap();
        }
        let history = store.subagents(&sid).unwrap();
        assert_eq!(history.len(), 81);
        assert!(history.iter().any(|a| a.id == "done-0"));
        assert!(history.iter().any(|a| a.id == "still-active"));
        assert!(history.iter().any(|a| a.id == "done-79"));
        let mut live = SubagentState::default();
        live.entries.insert(
            "new-worker".into(),
            Entry {
                activity: child("new-worker", "running"),
                last_saved: None,
                saved_status: String::new(),
                last_emitted: None,
                emitted_status: String::new(),
                emitted_tools: 0,
                emitted_tool_statuses: Vec::new(),
                dirty_emit: false,
                seq: 0,
                number: 1,
            },
        );
        let merged = live.merge_history(history);
        assert_eq!(merged.len(), 82);
        assert!(merged.iter().take(2).all(|a| a.status == "running"));
        store
            .db
            .execute("DELETE FROM sessions WHERE id=?1", [&sid])
            .unwrap();
        assert_eq!(
            store
                .db
                .query_row("SELECT COUNT(*) FROM subagents", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn a_run_records_more_active_children_than_the_old_limit_and_large_snapshots() {
        let store = Mutex::new(Store::open(std::path::Path::new(":memory:")).unwrap());
        let sid = task(&store.lock().unwrap());
        let mut state = SubagentState::default();
        for n in 0..70 {
            let mut activity = child(&format!("worker-{n}"), "running");
            activity.response = "x".repeat(if n == 0 { 2 * 1024 * 1024 } else { 8 });
            record(&mut state, &store, &sid, "run", activity);
        }
        assert_eq!(state.active_summaries().len(), 70);
        assert_eq!(state.merge_history(Vec::new()).len(), 70);
        assert_eq!(store.lock().unwrap().subagents(&sid).unwrap().len(), 70);
    }

    #[test]
    fn list_rows_stay_small_whatever_the_snapshots_weigh_and_the_full_one_is_a_call_away() {
        const CHILDREN: usize = 300;
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let sid = task(&store);
        let heavy = |n: usize| {
            let mut activity = child(&format!("worker-{n}"), "completed");
            activity.prompt = "p".repeat(8 * 1024);
            activity.response = "🦀".repeat(64 * 1024);
            activity.tools = vec![activity.tools[0].clone(); 64];
            activity
        };
        for n in 0..CHILDREN {
            store.save_subagent(&sid, &heavy(n)).unwrap();
        }
        let rows = store.subagent_rows(&sid).unwrap();
        assert_eq!(rows.len(), CHILDREN);
        let bytes = serde_json::to_vec(&rows).unwrap().len();
        assert!(bytes < CHILDREN * 8 * 1024, "{bytes} bytes for the list");
        assert_eq!(rows[0].response.chars().count(), PREVIEW_CHARS as usize);
        assert_eq!(rows[0].tool_count, 64);
        assert!(!serde_json::to_string(&rows[0]).unwrap().contains("\"tools\""));
        let full = store.subagent(&sid, "worker-7").unwrap().unwrap();
        assert_eq!(full, heavy(7), "the full snapshot is untouched");
        assert!(store.subagent(&sid, "missing").unwrap().is_none());
        assert_eq!(rows.iter().find(|row| row.id == "worker-7").unwrap(), &SubagentRow::from(&full), "live and saved rows agree");
    }

    #[test]
    fn live_rows_override_saved_ones_and_settle_order_matches_the_full_merge() {
        let store = Mutex::new(Store::open(std::path::Path::new(":memory:")).unwrap());
        let sid = task(&store.lock().unwrap());
        let mut state = SubagentState::default();
        let mut activity = child("worker", "running");
        record(&mut state, &store, &sid, "run", activity.clone());
        activity.response = "Newer than the checkpoint".into();
        record(&mut state, &store, &sid, "run", activity);
        let mut settled = child("old", "completed");
        settled.updated_at = 5000;
        store.lock().unwrap().save_subagent(&sid, &settled).unwrap();
        let db = store.lock().unwrap();
        let rows = state.merge_rows(db.subagent_rows(&sid).unwrap());
        let full = state.merge_history(db.subagents(&sid).unwrap());
        assert_eq!(rows.iter().map(|row| &row.id).collect::<Vec<_>>(), full.iter().map(|child| &child.id).collect::<Vec<_>>());
        assert_eq!(rows[0].response, "Newer than the checkpoint");
        assert_eq!(rows[0].tool_count, 1);
    }

    #[test]
    fn a_failed_checkpoint_keeps_live_work_for_retry() {
        let store = Mutex::new(Store::open(std::path::Path::new(":memory:")).unwrap());
        let sid = task(&store.lock().unwrap());
        let mut state = SubagentState::default();
        store.lock().unwrap().db.execute_batch("CREATE TRIGGER reject_child BEFORE INSERT ON subagents BEGIN SELECT RAISE(ABORT,'test full disk'); END;").unwrap();
        let mut event = crate::event(&sid, "subagent", "");
        event.data = Some(serde_json::to_value(child("worker", "running")).unwrap());
        assert!(state.record(&store, "run", &mut event).is_err());
        assert_eq!(state.merge_history(Vec::new())[0].response, "Reading");
        let db = store.lock().unwrap();
        db.db.execute_batch("DROP TRIGGER reject_child;").unwrap();
        state.finish(&db, &sid, "stopped").1.unwrap();
        assert_eq!(db.subagents(&sid).unwrap()[0].response, "Reading");
    }

    #[test]
    fn history_command_returns_live_work_and_retries_cleanup_when_the_run_is_gone() {
        use crate::{AppState, RunningAgent};
        use std::sync::{
            atomic::{AtomicBool, AtomicU8},
            Arc,
        };
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let sid = task(&store);
        let state = AppState {
            store: Arc::new(Mutex::new(store)),
            agents: Arc::new(Mutex::new(HashMap::new())),
            terminals: Arc::new(Mutex::new(HashMap::new())),
            shutdown: AtomicU8::new(0),
        };
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let agent = RunningAgent::new(tx, Arc::new(AtomicBool::new(false)));
        let snapshots = agent.subagents.clone();
        let run = agent.run_id.clone();
        state.agents.lock().unwrap().insert(sid.clone(), agent);
        let mut activity = child("worker", "running");
        record(
            &mut snapshots.lock().unwrap(),
            &state.store,
            &sid,
            &run,
            activity.clone(),
        );
        activity.response = "Fresh live response".into();
        record(
            &mut snapshots.lock().unwrap(),
            &state.store,
            &sid,
            &run,
            activity,
        );
        assert_eq!(
            crate::task_subagents(&state, &sid).unwrap()[0].response,
            "Fresh live response"
        );
        assert_eq!(
            crate::task_subagent(&state, &sid, "run:worker").unwrap().map_or(0, |child| child.tools.len()),
            0,
            "another run's id is not this child"
        );
        assert_eq!(
            crate::task_subagent(&state, &sid, &format!("{run}:worker")).unwrap().unwrap().response,
            "Fresh live response",
            "a running child's full snapshot is the live one, not the checkpoint"
        );
        assert_eq!(
            state.store.lock().unwrap().subagents(&sid).unwrap()[0].response,
            "Reading"
        );
        // A failed final persistence attempt can leave the on-disk child live
        // after the parent registry entry has been removed. Reads repair it.
        state.agents.lock().unwrap().remove(&sid);
        state.store.lock().unwrap().status(&sid, "error").unwrap();
        let recovered = crate::task_subagents(&state, &sid).unwrap();
        assert_eq!(recovered[0].status, "failed");
        assert_eq!(state.store.lock().unwrap().subagents(&sid).unwrap()[0].tools[0].status, "failed");
        assert_eq!(
            state.store.lock().unwrap().subagents(&sid).unwrap()[0].status,
            "failed"
        );
    }

    #[test]
    fn failed_final_writes_still_return_terminal_snapshots_for_live_emission() {
        let store = Mutex::new(Store::open(std::path::Path::new(":memory:")).unwrap());
        let sid = task(&store.lock().unwrap());
        let mut state = SubagentState::default();
        record(&mut state, &store, &sid, "run", child("worker", "running"));
        let db = store.lock().unwrap();
        db.db.execute_batch("CREATE TRIGGER reject_final_insert BEFORE INSERT ON subagents BEGIN SELECT RAISE(ABORT,'test full disk'); END;
            CREATE TRIGGER reject_final_update BEFORE UPDATE ON subagents BEGIN SELECT RAISE(ABORT,'test full disk'); END;").unwrap();
        let (changed, saved) = state.finish(&db, &sid, "stopped");
        assert!(
            saved.is_err(),
            "Parent completion must retain the persistence failure"
        );
        assert_eq!(
            changed.len(),
            1,
            "Live settlement must still be emitted on save failure"
        );
        assert_eq!(changed[0].status, "stopped");
        assert_eq!(changed[0].tools[0].status, "failed");
        assert_eq!(db.subagents(&sid).unwrap()[0].status, "running");
        assert_eq!(
            state.merge_history(db.subagents(&sid).unwrap())[0].status,
            "stopped"
        );
        db.db
            .execute_batch("DROP TRIGGER reject_final_insert; DROP TRIGGER reject_final_update;")
            .unwrap();
        state.finish(&db, &sid, "stopped").1.unwrap();
        assert_eq!(db.subagents(&sid).unwrap()[0].status, "stopped");
    }

    #[test]
    fn streaming_updates_throttle_serialization_within_150ms_and_flush_on_transitions_or_finish() {
        let store = Mutex::new(Store::open(std::path::Path::new(":memory:")).unwrap());
        let sid = task(&store.lock().unwrap());
        let mut state = SubagentState::default();
        let mut activity = child("worker", "running");
        activity.tools[0].status = "completed".into();

        let push = |state: &mut SubagentState, snap: SubagentActivity| -> (bool, Option<serde_json::Value>) {
            let mut event = crate::event(&sid, "subagent", "");
            event.data = Some(serde_json::to_value(snap).unwrap());
            let emit = state.record(&store, "run", &mut event).unwrap();
            (emit, event.data)
        };

        // First sighting emits immediately with serialized payload.
        let (emit, data) = push(&mut state, activity.clone());
        assert!(emit && data.is_some());

        // Back-to-back streaming updates within 150ms skip `to_value` while updating memory.
        for n in 0..25 {
            activity.response = format!("chunk {n}");
            let (emit, data) = push(&mut state, activity.clone());
            assert!(!emit, "intermediate chunk {n} within 150ms must not emit");
            assert!(data.is_none(), "throttled update must skip event.data serialization");
        }
        assert_eq!(state.get("run:worker").unwrap().response, "chunk 24");

        // Tool-count transition emits immediately even inside the 150ms window.
        activity.tools.push(ToolActivity {
            id: "grep".into(),
            name: "Grep".into(),
            status: "completed".into(),
            input: "foo".into(),
            output: "bar".into(),
            write_paths: None,
        });
        let (emit, data) = push(&mut state, activity.clone());
        assert!(emit && data.is_some());

        // Elapsed >= 150ms emits immediately.
        state.entries.get_mut("run:worker").unwrap().last_emitted =
            Some(Instant::now() - EMIT_INTERVAL);
        activity.response = "after interval".into();
        let (emit, data) = push(&mut state, activity.clone());
        assert!(emit && data.is_some());

        // Terminal snapshots never throttle, even when a post-settlement suffix arrives inside 150ms.
        activity.status = "completed".into();
        let (emit, data) = push(&mut state, activity.clone());
        assert!(emit && data.is_some());
        activity.response = "completed trailing suffix".into();
        let (emit, data) = push(&mut state, activity);
        assert!(emit && data.is_some());

        // A throttled running update is settled and returned by `finish()`.
        let mut live = child("live-worker", "running");
        live.tools[0].status = "completed".into();
        assert!(push(&mut state, live.clone()).0);
        live.response = "running trailing suffix".into();
        let (emit, data) = push(&mut state, live);
        assert!(!emit && data.is_none());

        let db = store.lock().unwrap();
        let (changed, saved) = state.finish(&db, &sid, "stopped");
        saved.unwrap();
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].id, "run:live-worker");
        assert_eq!(changed[0].response, "running trailing suffix");
    }

    #[test]
    fn in_place_tool_status_transition_within_150ms_emits_immediately() {
        let store = Mutex::new(Store::open(std::path::Path::new(":memory:")).unwrap());
        let sid = task(&store.lock().unwrap());
        let mut state = SubagentState::default();
        let mut activity = child("worker", "running");
        assert_eq!(activity.tools.len(), 1);
        assert_eq!(activity.tools[0].status, "running");

        let mut first = crate::event(&sid, "subagent", "");
        first.data = Some(serde_json::to_value(&activity).unwrap());
        assert!(state.record(&store, "run", &mut first).unwrap());
        assert!(first.data.is_some());

        // Tool finishes in < 150ms while tools.len() == 1 and subagent stays "running".
        activity.tools[0].status = "completed".into();
        activity.tools[0].output = "42 lines".into();
        let mut second = crate::event(&sid, "subagent", "");
        second.data = Some(serde_json::to_value(&activity).unwrap());
        assert!(
            state.record(&store, "run", &mut second).unwrap(),
            "in-place tool status change must emit immediately inside 150ms"
        );
        let emitted: SubagentActivity = serde_json::from_value(second.data.unwrap()).unwrap();
        assert_eq!(emitted.tools.len(), 1);
        assert_eq!(emitted.tools[0].status, "completed");
        assert!(!state.has_dirty());
    }

    #[test]
    fn post_settlement_completed_snapshot_within_150ms_emits_immediately() {
        let store = Mutex::new(Store::open(std::path::Path::new(":memory:")).unwrap());
        let sid = task(&store.lock().unwrap());
        let mut state = SubagentState::default();
        let mut activity = child("worker", "completed");
        activity.tools[0].status = "completed".into();

        let mut first = crate::event(&sid, "subagent", "");
        first.data = Some(serde_json::to_value(&activity).unwrap());
        assert!(state.record(&store, "run", &mut first).unwrap());

        // Post-settlement snapshot within < 150ms of the earlier "completed" snapshot.
        activity.response = "Final summary after settlement".into();
        let mut second = crate::event(&sid, "subagent", "");
        second.data = Some(serde_json::to_value(&activity).unwrap());
        assert!(
            state.record(&store, "run", &mut second).unwrap(),
            "settled snapshots must never be throttled"
        );
        let emitted: SubagentActivity = serde_json::from_value(second.data.unwrap()).unwrap();
        assert_eq!(emitted.status, "completed");
        assert_eq!(emitted.response, "Final summary after settlement");
        assert!(!state.has_dirty());
    }

    #[test]
    fn rapid_running_text_deltas_coalesce_and_flush_due_emits_latest_once() {
        let store = Mutex::new(Store::open(std::path::Path::new(":memory:")).unwrap());
        let sid = task(&store.lock().unwrap());
        let mut state = SubagentState::default();
        let mut activity = child("worker", "running");
        activity.tools[0].status = "completed".into();

        let mut first = crate::event(&sid, "subagent", "");
        first.data = Some(serde_json::to_value(&activity).unwrap());
        assert!(state.record(&store, "run", &mut first).unwrap());
        assert!(!state.has_dirty());

        for n in 1..=5 {
            activity.response = format!("delta {n}");
            let mut ev = crate::event(&sid, "subagent", "");
            ev.data = Some(serde_json::to_value(&activity).unwrap());
            assert!(!state.record(&store, "run", &mut ev).unwrap());
            assert!(ev.data.is_none());
        }
        assert!(state.has_dirty());
        // Before EMIT_INTERVAL elapses, non-forced flush_due holds back.
        assert!(state.flush_due(&sid, false).unwrap().is_empty());
        assert!(state.has_dirty());

        // After EMIT_INTERVAL elapses, flush_due(..., false) emits the latest snapshot once.
        state.entries.get_mut("run:worker").unwrap().last_emitted =
            Some(Instant::now() - EMIT_INTERVAL);
        let flushed = state.flush_due(&sid, false).unwrap();
        assert_eq!(flushed.len(), 1);
        assert_eq!(flushed[0].session_id, sid);
        assert_eq!(flushed[0].kind, "subagent");
        let payload: SubagentActivity =
            serde_json::from_value(flushed[0].data.clone().unwrap()).unwrap();
        assert_eq!(payload.response, "delta 5");
        assert!(!state.has_dirty());
        assert!(state.flush_due(&sid, false).unwrap().is_empty());

        // Forced flush_due(..., true) flushes immediately even inside EMIT_INTERVAL.
        activity.response = "delta 6".into();
        let mut ev = crate::event(&sid, "subagent", "");
        ev.data = Some(serde_json::to_value(&activity).unwrap());
        assert!(!state.record(&store, "run", &mut ev).unwrap());
        assert!(state.has_dirty());
        let forced = state.flush_due(&sid, true).unwrap();
        assert_eq!(forced.len(), 1);
        let payload: SubagentActivity =
            serde_json::from_value(forced[0].data.clone().unwrap()).unwrap();
        assert_eq!(payload.response, "delta 6");
        assert!(!state.has_dirty());
    }

    #[test]
    fn seq_strictly_increases_across_creation_coalesced_flush_tool_transition_and_completion() {
        let store = Mutex::new(Store::open(std::path::Path::new(":memory:")).unwrap());
        let sid = task(&store.lock().unwrap());
        let mut state = SubagentState::default();
        let mut activity = child("worker", "running");

        let push =
            |state: &mut SubagentState, snap: SubagentActivity| -> (bool, Option<serde_json::Value>) {
                let mut ev = crate::event(&sid, "subagent", "");
                ev.data = Some(serde_json::to_value(snap).unwrap());
                let emit = state.record(&store, "run", &mut ev).unwrap();
                (emit, ev.data)
            };

        // 1. Initial creation emits seq == 1.
        let (emit, data) = push(&mut state, activity.clone());
        assert!(emit);
        let seq_created = data.unwrap()["seq"].as_u64().unwrap();
        assert_eq!(seq_created, 1);

        // 2. Coalesced running deltas advance seq internally, and flush_due emits latest seq.
        for n in 1..=3 {
            activity.response = format!("delta {n}");
            let (emit, data) = push(&mut state, activity.clone());
            assert!(!emit && data.is_none());
        }
        state.entries.get_mut("run:worker").unwrap().last_emitted =
            Some(Instant::now() - EMIT_INTERVAL);
        let flushed = state.flush_due(&sid, false).unwrap();
        assert_eq!(flushed.len(), 1);
        let seq_flushed = flushed[0].data.as_ref().unwrap()["seq"].as_u64().unwrap();
        assert!(seq_flushed > seq_created);
        assert_eq!(seq_flushed, 4);

        // 3. Another coalesced delta followed by an immediate tool-status transition inside 150ms.
        activity.response = "delta 4".into();
        let (emit, data) = push(&mut state, activity.clone());
        assert!(!emit && data.is_none());
        activity.tools[0].status = "completed".into();
        activity.tools[0].output = "done".into();
        let (emit, data) = push(&mut state, activity.clone());
        assert!(emit);
        let seq_tool_transition = data.unwrap()["seq"].as_u64().unwrap();
        assert!(seq_tool_transition > seq_flushed);
        assert_eq!(seq_tool_transition, 6);
        assert!(!state.has_dirty());

        // 4. Terminal completion emits strictly higher seq.
        activity.status = "completed".into();
        activity.response = "All done".into();
        let (emit, data) = push(&mut state, activity.clone());
        assert!(emit);
        let seq_completed = data.unwrap()["seq"].as_u64().unwrap();
        assert!(seq_completed > seq_tool_transition);
        assert_eq!(seq_completed, 7);

        // 5. Post-settlement completion suffix also advances seq strictly.
        activity.response = "All done (final)".into();
        let (emit, data) = push(&mut state, activity);
        assert!(emit);
        let seq_post_completed = data.unwrap()["seq"].as_u64().unwrap();
        assert!(seq_post_completed > seq_completed);
        assert_eq!(seq_post_completed, 8);
    }
}
