//! Subagent snapshots, run state transitions and remote cursors.

use super::schema_v38::settle_unfinished_subagents;
use super::sql::DUE_LIMIT_RESUMES_SQL;
use super::{now, serialize_subagent, Result, Session, Store};
use rusqlite::{params, OptionalExtension};

impl Store {
    /// Saved Connect viewer cursors: (host device, host task, journal epoch, newest seq seen).
    pub fn remote_cursors(&self) -> Result<Vec<(String, String, String, u64)>> {
        let mut statement = self.db.prepare("SELECT device,session,epoch,seq FROM remote_cursors").map_err(|e| e.to_string())?;
        let rows = statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)?.max(0) as u64))).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
    }

    /// Replaces one host's saved cursors with `seqs` under `epoch`.
    pub fn save_remote_cursors(&self, device: &str, epoch: &str, seqs: &[(String, u64)]) -> Result<()> {
        let transaction = self.db.unchecked_transaction().map_err(|e| e.to_string())?;
        transaction.execute("DELETE FROM remote_cursors WHERE device=?1", [device]).map_err(|e| e.to_string())?;
        let mut insert = transaction.prepare("INSERT INTO remote_cursors(device,session,epoch,seq) VALUES (?1,?2,?3,?4)").map_err(|e| e.to_string())?;
        for (session, seq) in seqs {
            insert.execute(params![device, session, epoch, i64::try_from(*seq).unwrap_or(i64::MAX)]).map_err(|e| e.to_string())?;
        }
        drop(insert);
        transaction.commit().map_err(|e| e.to_string())
    }

    /// Records a usage limit hit by the task's run.
    pub fn set_limited(&self, sid: &str, until: Option<i64>) -> Result<()> {
        let until = until.filter(|at| *at > 0 && *at < 4_102_444_800_000);
        self.db.prepare_cached("UPDATE sessions SET limited_at=?2,limited_until=?3 WHERE id=?1").and_then(|mut statement| statement.execute(params![sid, now(), until])).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Turns automatic continuation at the reset on or off for a limited task.
    pub fn set_resume_at_reset(&self, sid: &str, enabled: bool) -> Result<Session> {
        let changed = self.db.prepare_cached("UPDATE sessions SET resume_at_reset=?2 WHERE id=?1 AND limited_at IS NOT NULL AND (?2=0 OR limited_until IS NOT NULL)").and_then(|mut statement| statement.execute(params![sid, enabled])).map_err(|e| e.to_string())?;
        if changed == 0 && enabled {
            return Err("This task has no usage limit with a known reset time.".into());
        }
        self.session(sid)
    }

    /// Clears a limit once it has been handled (resumed, archived or dismissed).
    pub fn clear_limited(&self, sid: &str) -> Result<()> {
        self.db.prepare_cached("UPDATE sessions SET limited_at=NULL,limited_until=NULL,resume_at_reset=0 WHERE id=?1").and_then(|mut statement| statement.execute([sid])).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Tasks set to resume at reset whose limit has lifted (`pandacode serve` resumes them;
    /// the desktop window schedules the same sends from the frontend).
    pub fn due_limit_resumes(&self, now: i64) -> Result<Vec<String>> {
        let mut statement = self
            .db
            .prepare_cached(DUE_LIMIT_RESUMES_SQL)
            .map_err(|e| e.to_string())?;
        let rows = statement.query_map([now], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
    }

    pub fn record_goal(
        &self,
        sid: &str,
        goal: Option<&crate::goal_state::GoalState>,
    ) -> Result<()> {
        let (provider, resume_id): (String, Option<String>) =
            self.session_columns("SELECT provider,resume_id FROM sessions WHERE id=?1", sid, |r| Ok((r.get(0)?, r.get(1)?)))?;
        if goal.is_some_and(|g| {
            !g.is_valid()
                || provider != "codex"
                || resume_id.as_deref() != Some(&g.thread_id)
        }) {
            return Err("Goal metadata does not belong to this Codex task.".into());
        }
        let data = goal
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| e.to_string())?;
        self.db
            .execute(
                "UPDATE sessions SET goal_state=?2 WHERE id=?1",
                params![sid, data],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// A cloud run re-attached after a restart: running again, so a Stop saved before the
    /// quit no longer counts.
    pub fn reattach_turn(&self, sid: &str) -> Result<()> {
        self.db.execute("UPDATE sessions SET status='running',task_stage='in_progress',completed_at=NULL,stop_requested=0 WHERE id=?1", [sid]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn begin_goal_operation(&self, sid: &str) -> Result<()> {
        let (archived, task_stage): (bool, String) =
            self.session_columns("SELECT archived,task_stage FROM sessions WHERE id=?1", sid, |r| Ok((r.get(0)?, r.get(1)?)))?;
        if archived || task_stage == "completed" {
            return Err("Reopen this task first.".into());
        }
        self.db.execute("UPDATE sessions SET status='running',task_stage='in_progress',completed_at=NULL,updated_at=?2,stop_requested=0 WHERE id=?1", params![sid,now()]).map_err(|e|e.to_string())?;
        Ok(())
    }

    /// Saves the user's Stop before the run is signalled (see `Store::open`). Only a
    /// running local task takes it; the next turn start clears it.
    pub fn request_stop(&self, sid: &str) -> Result<()> {
        self.db.execute("UPDATE sessions SET stop_requested=1 WHERE id=?1 AND status IN ('running','waiting') AND remote_device IS NULL", [sid]).map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn status(&self, sid: &str, status: &str) -> Result<()> {
        self.set_status_count(sid, status).map(|_| ()).map_err(|e| e.to_string())
    }
    /// [`Store::status`] through its cached statement; returns the rows updated.
    pub(crate) fn set_status_count(&self, id: &str, status: &str) -> rusqlite::Result<usize> {
        self.db
            .prepare_cached("UPDATE sessions SET status=?2,updated_at=?3 WHERE id=?1")?
            .execute(params![id, status, now()])
    }
    /// Claim execution and save its initiating message together. A failed insert
    /// rolls the claim back; concurrent callers cannot enqueue a second run.
    pub fn begin_task_turn(&self, sid: &str, content: &str) -> Result<i64> {
        self.begin_task_turn_with_kind(sid, content, None)
    }

    pub fn begin_task_turn_with_kind(
        &self,
        sid: &str,
        content: &str,
        kind: Option<crate::architect::internal_turns::CoordinationKind>,
    ) -> Result<i64> {
        self.begin_task_turn_reporting(sid, content, kind, &[])
    }

    /// As `begin_task_turn_with_kind`, also marking the machine threads `reported` reports
    /// in the same transaction, so a wake is never lost or repeated.
    pub fn begin_task_turn_reporting(
        &self,
        sid: &str,
        content: &str,
        kind: Option<crate::architect::internal_turns::CoordinationKind>,
        reported: &[String],
    ) -> Result<i64> {
        if content.trim().is_empty() || content.len() > crate::MESSAGE_LIMIT {
            return Err("Write a message under 16 MiB first.".into());
        }
        let transaction = self.db.unchecked_transaction().map_err(|e| e.to_string())?;
        let current_title: String = self.session_columns("SELECT title FROM sessions WHERE id=?1", sid, |r| r.get(0))?;
        let title: String = if kind.is_none() && current_title == "New conversation"
            && crate::session_titles::automatic(self, sid)? {
            content
                .lines()
                .next()
                .unwrap_or(content)
                .chars()
                .take(64)
                .collect()
        } else {
            current_title
        };
        let claimed = self
            .db
            .execute(
                "UPDATE sessions SET status='running',task_stage='in_progress',completed_at=NULL,
                title=?2,updated_at=?3,restart_interrupted=0,stop_requested=0 WHERE id=?1 AND archived=0 AND task_stage<>'completed'
                AND status NOT IN ('running','waiting')",
                params![sid, title, now()],
            )
            .map_err(|e| e.to_string())?;
        if claimed == 0 {
            return Err("Restore or reopen the task and stop its agent before starting it.".into());
        }
        let message_id = if let Some(kind) = kind {
            let saved = crate::architect::internal_turns::encode(kind, content)?;
            self.db.query_row("INSERT INTO messages(session_id,role,content,created_at) VALUES(?1,'coordination',?2,?3) RETURNING id",params![sid,saved,now()],|row|row.get(0)).map_err(|e|e.to_string())?
        } else {
            self.start_turn_message(sid, content)?
        };
        for child in reported {
            // A thread still running (its computer went offline) stays unreported: the wake told
            // of it once (`reported_by`), and its end reports as usual.
            self.db.execute("UPDATE machine_threads SET reported_by=?3,reported=NOT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND status IN ('running','waiting')) WHERE session_id=?1 AND parent_session_id=?2", params![child, sid, message_id]).map_err(|e| e.to_string())?;
        }
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(message_id)
    }

    pub fn finish_task_turn(&self, sid: &str, successful: bool, stopped: bool) -> Result<()> {
        self.finish_task_operation(sid, successful, stopped, None)
    }

    pub fn finish_task_operation(
        &self,
        sid: &str,
        successful: bool,
        stopped: bool,
        restore_stage: Option<&str>,
    ) -> Result<()> {
        if restore_stage.is_some_and(|stage| !matches!(stage, "pending" | "in_progress" | "review"))
        {
            return Err("Invalid task stage for a context command.".into());
        }
        let status = if stopped {
            "interrupted"
        } else if successful {
            "idle"
        } else {
            "error"
        };
        self.db
            .execute(
                "UPDATE sessions SET status=?2,restart_interrupted=0,
               task_stage=CASE WHEN json_valid(goal_state) AND json_extract(goal_state,'$.status')<>'complete' THEN 'in_progress' ELSE COALESCE(?5, CASE WHEN ?3 THEN 'review' ELSE 'in_progress' END) END,
               completed_at=NULL,updated_at=?4 WHERE id=?1",
                params![sid, status, successful && !stopped, now(), restore_stage],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Subagent history is independent of the bounded parent message window.
    pub fn save_subagent(
        &self,
        sid: &str,
        activity: &crate::providers::SubagentActivity,
    ) -> Result<()> {
        let content = serialize_subagent(activity)?;
        self.save_subagent_rows(sid, &[(activity.id.as_str(), content.as_str(), activity.updated_at)])
    }

    /// Upserts `(id, content, updated_at)` subagent rows (content from `serialize_subagent`) in
    /// one transaction, or the caller's.
    pub(crate) fn save_subagent_rows(&self, sid: &str, rows: &[(&str, &str, i64)]) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        self.in_transaction(|| {
            for (id, content, updated_at) in rows {
                self.upsert_subagent_row(sid, id, content, *updated_at)?;
            }
            Ok(())
        })
    }

    /// Upserts one subagent row with the cached statement, opening no transaction or savepoint:
    /// the caller owns atomicity (`save_subagent_rows`, or `subagent_state::flush`'s transaction).
    pub(crate) fn upsert_subagent_row(&self, sid: &str, id: &str, content: &str, updated_at: i64) -> Result<()> {
        self.db
            .prepare_cached("INSERT INTO subagents(session_id,id,content,updated_at) VALUES (?1,?2,?3,?4)
            ON CONFLICT(session_id,id) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at")
            .and_then(|mut upsert| upsert.execute(params![sid, id, content, updated_at]))
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub fn subagents(&self, sid: &str) -> Result<Vec<crate::providers::SubagentActivity>> {
        self.require_session(sid)?;
        let mut query = self
            .db
            .prepare_cached(
                "SELECT content FROM subagents WHERE session_id=?1
            ORDER BY updated_at DESC,id DESC",
            )
            .map_err(|error| error.to_string())?;
        let rows = query
            .query_map([sid], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.map(|row| {
            let content = row.map_err(|error| error.to_string())?;
            serde_json::from_str(&content).map_err(|error| error.to_string())
        })
        .collect()
    }

    /// The list of a task's children without their tools and with short previews. SQLite still
    /// parses each snapshot, but only this much of it crosses into Rust and on to the webview.
    // ponytail: the parse is linear in saved bytes; give `subagents` plain columns if a task's
    // history ever makes opening its thread slow.
    pub fn subagent_rows(&self, sid: &str) -> Result<Vec<crate::subagent_state::SubagentRow>> {
        self.require_session(sid)?;
        let mut query = self
            .db
            .prepare_cached(
                "SELECT id,json_extract(content,'$.parentId'),json_extract(content,'$.name'),
                    substr(json_extract(content,'$.prompt'),1,?2),json_extract(content,'$.status'),
                    substr(json_extract(content,'$.response'),1,?2),json_array_length(content,'$.tools'),
                    json_extract(content,'$.startedAt'),json_extract(content,'$.updatedAt')
                 FROM subagents WHERE session_id=?1 ORDER BY updated_at DESC,id DESC",
            )
            .map_err(|error| error.to_string())?;
        let rows = query
            .query_map(params![sid, crate::subagent_state::PREVIEW_CHARS], |row| {
                Ok(crate::subagent_state::SubagentRow {
                    id: row.get(0)?,
                    parent_id: row.get(1)?,
                    name: row.get(2)?,
                    prompt: row.get(3)?,
                    status: row.get(4)?,
                    response: row.get(5)?,
                    tool_count: row.get(6)?,
                    started_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.map(|row| row.map_err(|error| error.to_string())).collect()
    }

    /// One saved child in full.
    pub fn subagent(&self, sid: &str, id: &str) -> Result<Option<crate::providers::SubagentActivity>> {
        let content: Option<String> = self
            .db
            .prepare_cached("SELECT content FROM subagents WHERE session_id=?1 AND id=?2")
            .and_then(|mut statement| statement.query_row([sid, id], |row| row.get(0)))
            .optional()
            .map_err(|error| error.to_string())?;
        content.map(|content| serde_json::from_str(&content).map_err(|error| error.to_string())).transpose()
    }

    pub fn finish_subagents(&self, sid: &str, status: &str) -> Result<()> {
        settle_unfinished_subagents(&self.db, Some(sid), status, self.trackers_usable)
    }
}
