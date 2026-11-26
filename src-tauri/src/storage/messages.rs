//! Conversation rows, tool snapshots, search and usage.

use super::schema_v38::settle_unfinished_tools;
use super::sql::{IMPORTED_TASK_SQL, PROJECT_LINKS_SQL, PROMPT_ACTIVITY_SQL, SEARCH_TASKS_SQL, USER_TURNS_SQL};
use super::{now, ContextUsage, Message, MessagePage, Result, Session, Store, TaskLink, DEFAULT_PERMISSION_MODE, MAX_DISMISS_ERROR_IDS, SESSION_NOT_FOUND};
use rusqlite::{params, OptionalExtension};

impl Store {
    /// Prompts sent from PandaCode per hour and agent since `since_ms`, for the usage calendar.
    pub fn prompt_activity(&self, since_ms: i64) -> Result<Vec<(i64, String, u64)>> {
        let mut statement = self
            .db
            .prepare_cached(PROMPT_ACTIVITY_SQL)
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([since_ms], |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)?.max(0) as u64)))
            .map_err(|e| e.to_string())?;
        rows.collect::<std::result::Result<_, _>>().map_err(|e| e.to_string())
    }
    /// Tasks in a project whose title or conversation mentions `query`, newest first,
    /// each with a short excerpt around the first match in its messages.
    pub fn search_tasks(&self, project_id: &str, query: &str, limit: usize) -> Result<Vec<serde_json::Value>> {
        let query = query.trim();
        if query.is_empty() || query.chars().count() > 200 {
            return Err("Search for 1 to 200 characters.".into());
        }
        let pattern = format!("%{}%", query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        let mut statement = self.db.prepare_cached(SEARCH_TASKS_SQL).map_err(|e| e.to_string())?;
        let needle = query.to_lowercase();
        let rows = statement.query_map(params![project_id, pattern, limit as i64], |r| {
            let content: Option<String> = r.get(3)?;
            let excerpt = content.map(|text| {
                let lower = text.to_lowercase();
                let at = lower.find(&needle).unwrap_or(0);
                let start = text.char_indices().map(|(i, _)| i).take_while(|i| *i + 80 <= at).last().unwrap_or(0);
                text[start..].chars().take(220).collect::<String>()
            });
            Ok(serde_json::json!({"taskId": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?, "updatedAt": r.get::<_, i64>(2)?, "excerpt": excerpt}))
        }).map_err(|e| e.to_string())?;
        rows.collect::<std::result::Result<_, _>>().map_err(|e| e.to_string())
    }

    /// The PandaCode task already continuing an agent conversation, if any.
    pub fn imported_task(&self, provider: &str, resume_id: &str) -> Result<Option<String>> {
        self.db
            .prepare_cached(IMPORTED_TASK_SQL)
            .and_then(|mut statement| statement.query_row(params![provider, resume_id], |row| row.get(0)))
            .optional()
            .map_err(|e| e.to_string())
    }

    /// Adds a conversation started outside PandaCode as a task that continues it:
    /// its history keeps original times, and the agent resumes `resume_id` on the next prompt.
    #[allow(clippy::too_many_arguments)]
    pub fn import_task(&self, project_id: &str, provider: &str, model: &str, title: &str, resume_id: &str, reasoning_effort: Option<&str>, created_at: i64, entries: &[(&str, String, i64)]) -> Result<Session> {
        let transaction = self.db.unchecked_transaction().map_err(|e| e.to_string())?;
        let task = self.create_session(project_id, provider, model, DEFAULT_PERMISSION_MODE)?;
        let title: String = title.chars().filter(|c| !c.is_control()).take(200).collect();
        let title = if title.trim().is_empty() { "Imported conversation".to_owned() } else { title.trim().to_owned() };
        let first = entries.first().map_or(created_at, |entry| entry.2).min(created_at.max(1));
        let last = entries.last().map_or(created_at, |entry| entry.2).max(first);
        self.db
            .execute(
                "UPDATE sessions SET resume_id=?2,title=?3,title_origin='manual',reasoning_effort=?4,task_stage='in_progress',created_at=?5,updated_at=?6 WHERE id=?1",
                params![task.id, resume_id, title, reasoning_effort, first, last],
            )
            .map_err(|e| e.to_string())?;
        {
            let mut insert = self
                .db
                .prepare_cached("INSERT INTO messages(session_id,role,content,created_at) VALUES (?1,?2,?3,?4)")
                .map_err(|e| e.to_string())?;
            for (role, content, at) in entries {
                insert.execute(params![task.id, role, content, at]).map_err(|e| e.to_string())?;
            }
        }
        transaction.commit().map_err(|e| e.to_string())?;
        self.session(&task.id)
    }

    pub(super) fn attach_links(&self, sessions: &mut [Session]) -> Result<()> {
        if sessions.is_empty() {
            return Ok(());
        }
        let link = |r: &rusqlite::Row<'_>, at: usize| -> rusqlite::Result<TaskLink> {
            Ok(TaskLink {
                kind: r.get(at)?,
                number: r.get(at + 1)?,
                url: r.get(at + 2)?,
                title: r.get(at + 3)?,
                state: r.get(at + 4)?,
                checked_at: r.get(at + 5)?,
            })
        };
        let place = |session: &mut Session, link: TaskLink| {
            if link.kind == "pull" {
                session.pull_request = Some(link);
            } else {
                session.issue = Some(link);
            }
        };
        if let [session] = sessions {
            // One task (`session`): a primary-key seek instead of reading every link.
            let mut stmt = self
                .db
                .prepare_cached("SELECT kind,number,url,title,state,checked_at FROM task_links WHERE session_id=?1")
                .map_err(|e| e.to_string())?;
            let links = stmt
                .query_map([&session.id], |r| link(r, 0))
                .map_err(|e| e.to_string())?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            for found in links {
                place(session, found);
            }
            return Ok(());
        }
        let found = {
            // The first task with an id takes its links, as a linear search would.
            let mut index: std::collections::HashMap<&str, usize> = std::collections::HashMap::with_capacity(sessions.len());
            for (at, session) in sessions.iter().enumerate() {
                index.entry(session.id.as_str()).or_insert(at);
            }
            let mut stmt = self
                .db
                .prepare_cached("SELECT session_id,kind,number,url,title,state,checked_at FROM task_links")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, link(r, 1)?)))
                .map_err(|e| e.to_string())?;
            let mut found = Vec::new();
            for row in rows {
                let (session_id, task_link) = row.map_err(|e| e.to_string())?;
                if let Some(&at) = index.get(session_id.as_str()) {
                    found.push((at, task_link));
                }
            }
            found
        };
        for (at, task_link) in found {
            place(&mut sessions[at], task_link);
        }
        Ok(())
    }
    /// Replace the task's link of one kind; `None` removes it.
    pub fn set_task_link(&self, sid: &str, kind: &str, link: Option<&TaskLink>) -> Result<Session> {
        if !["issue", "pull"].contains(&kind) {
            return Err("Unknown link kind.".into());
        }
        self.require_session(sid)?;
        match link {
            Some(link) => {
                if link.number <= 0 || link.url.len() > 2048 || link.title.len() > 1024 || link.state.len() > 32 {
                    return Err("Invalid GitHub link.".into());
                }
                self.db.execute("INSERT INTO task_links(session_id,kind,number,url,title,state,checked_at) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(session_id,kind) DO UPDATE SET number=excluded.number,url=excluded.url,title=excluded.title,state=excluded.state,checked_at=excluded.checked_at",
                    params![sid, kind, link.number, link.url, link.title, link.state, now()]).map_err(|e| e.to_string())?;
            }
            None => {
                self.db
                    .execute("DELETE FROM task_links WHERE session_id=?1 AND kind=?2", params![sid, kind])
                    .map_err(|e| e.to_string())?;
            }
        }
        self.session(sid)
    }
    /// Linked numbers for one project, so states can be refreshed in one batch.
    pub fn project_links(&self, project_id: &str) -> Result<Vec<(String, TaskLink)>> {
        let mut stmt = self.db.prepare_cached(PROJECT_LINKS_SQL).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([project_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    TaskLink {
                        kind: r.get(1)?,
                        number: r.get(2)?,
                        url: r.get(3)?,
                        title: r.get(4)?,
                        state: r.get(5)?,
                        checked_at: r.get(6)?,
                    },
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
    /// Record refreshed states without touching which task owns which link.
    pub fn update_link_states(&self, project_id: &str, states: &[(String, i64, String, String)]) -> Result<()> {
        if states.is_empty() {
            return Ok(());
        }
        // One write transaction for the batch, unless the caller already holds one.
        self.in_transaction(|| {
            let mut update = self
                .db
                .prepare_cached("UPDATE task_links SET state=?3,title=CASE WHEN ?4='' THEN title ELSE ?4 END,checked_at=?5 WHERE kind=?1 AND number=?2 AND session_id IN (SELECT id FROM sessions WHERE project_id=?6)")
                .map_err(|e| e.to_string())?;
            for (kind, number, state, title) in states {
                update.execute(params![kind, number, state, title, now(), project_id]).map_err(|e| e.to_string())?;
            }
            Ok(())
        })
    }
    /// How many messages the user has sent in a task, including the one being sent.
    pub fn user_turns(&self, sid: &str) -> Result<i64> {
        self.db.prepare_cached(USER_TURNS_SQL).and_then(|mut statement| statement.query_row([sid], |r| r.get(0))).map_err(|e| e.to_string())
    }
    pub fn record_context_usage(&self, sid: &str, usage: &ContextUsage) -> Result<()> {
        if !usage.is_valid() {
            return Err("Invalid context usage metadata.".into());
        }
        let changed = self
            .db
            .prepare_cached("UPDATE sessions SET context_used_tokens=?2,context_window=?3 WHERE id=?1")
            .and_then(|mut statement| {
                statement.execute(params![
                    sid,
                    usage.used_tokens as i64,
                    usage.context_window.map(|window| window as i64)
                ])
            })
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err(SESSION_NOT_FOUND.into());
        }
        Ok(())
    }
    pub fn resume(&self, sid: &str, resume_id: &str) -> Result<()> {
        self.db
            .prepare_cached("UPDATE sessions SET resume_id=?2,goal_state=CASE WHEN resume_id=?2 THEN goal_state ELSE NULL END WHERE id=?1")
            .and_then(|mut statement| statement.execute(params![sid, resume_id]))
            .map_err(|e| e.to_string())?;
        self.db
            .prepare_cached("INSERT OR IGNORE INTO task_usage_links(session_id,harness_id,created_at) VALUES (?1,?2,?3)")
            .and_then(|mut statement| statement.execute(params![sid, resume_id, now()]))
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    /// Every harness session id the task has run under, including the current resume id.
    pub fn usage_links(&self, sid: &str) -> Result<Vec<String>> {
        let mut stmt = self
            .db
            .prepare("SELECT harness_id FROM task_usage_links WHERE session_id=?1 UNION SELECT resume_id FROM sessions WHERE id=?1 AND resume_id IS NOT NULL")
            .map_err(|e| e.to_string())?;
        let mut ids: Vec<String> = stmt
            .query_map([sid], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .collect::<std::result::Result<_, _>>()
            .map_err(|e| e.to_string())?;
        ids.sort();
        ids.dedup();
        Ok(ids)
    }
    pub fn message(&self, sid: &str, role: &str, content: &str) -> Result<()> {
        self.insert_message(sid, role, content).map(|_| ())
    }
    /// `message`, returning the new row's id (an error event carries it so the window can dismiss that row).
    pub fn insert_message(&self, sid: &str, role: &str, content: &str) -> Result<i64> {
        self.db
            .prepare_cached("INSERT INTO messages(session_id,role,content,created_at) VALUES (?1,?2,?3,?4)")
            .and_then(|mut statement| statement.execute(params![sid, role, content, now()]))
            .map_err(|e| e.to_string())?;
        Ok(self.db.last_insert_rowid())
    }
    /// Deletes only `role='error'` rows of `sid` whose id is listed; every other id is left alone.
    /// A plain delete stays consistent: the running-row trackers drop a deleted row's entry
    /// through `running_tools`'s foreign key (`running_subagents` is keyed to `subagents`), and
    /// messages carry no other derived state.
    /// A task that runs on another computer (`remote_device`) deletes nothing: its rows are copies
    /// the mirror's backfill (`remote/mirror.rs` `oldest_copied`) could copy back, so the window
    /// only hides them for the app session.
    pub fn dismiss_error_messages(&self, sid: &str, ids: &[i64]) -> Result<usize> {
        if ids.len() > MAX_DISMISS_ERROR_IDS {
            return Err(format!("Dismiss at most {MAX_DISMISS_ERROR_IDS} errors at a time."));
        }
        if ids.is_empty() {
            return Ok(0);
        }
        let tx = self.db.unchecked_transaction().map_err(|e| e.to_string())?;
        let mut deleted = 0;
        {
            let mut stmt = tx
                .prepare("DELETE FROM messages WHERE session_id=?1 AND role='error' AND id=?2 AND NOT EXISTS (SELECT 1 FROM sessions WHERE id=?1 AND remote_device IS NOT NULL)")
                .map_err(|e| e.to_string())?;
            for id in ids {
                deleted += stmt.execute(params![sid, id]).map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(deleted)
    }
    /// The newest `limit` tool records of the session whose saved JSON contains
    /// `fragment` (see `tool_images::search_fragment`). Only a cheap prefilter: the
    /// caller parses and matches the records after releasing the store lock.
    /// Newest first, older than message `before` when given, so callers can page with the lock
    /// released between batches. Returns (message id, content).
    pub fn tool_records_containing(&self, sid: &str, fragment: &str, before: Option<i64>, limit: usize) -> Result<Vec<(i64, String)>> {
        let mut stmt = self.db.prepare_cached(
            "SELECT id, content FROM messages WHERE session_id=?1 AND role='tool' AND instr(content,?2)>0 AND id<?3 ORDER BY id DESC LIMIT ?4",
        ).map_err(|e| e.to_string())?;
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let before = before.unwrap_or(i64::MAX);
        let rows = stmt
            .query_map(params![sid, fragment, before, limit], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<std::result::Result<_, _>>().map_err(|e| e.to_string())
    }
    /// RETURNING ties the timer to this exact insert even with concurrent tasks.
    pub fn start_turn_message(&self, sid: &str, content: &str) -> Result<i64> {
        self.db
            .query_row(
                "INSERT INTO messages(session_id,role,content,created_at)
            VALUES (?1,'user',?2,?3) RETURNING id",
                params![sid, content, now()],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())
    }

    pub fn finish_turn(&self, sid: &str, message_id: i64, duration_ms: i64) -> Result<()> {
        if duration_ms < 0 {
            return Err("Turn duration cannot be negative.".into());
        }
        let changed = self
            .db
            .execute(
                "UPDATE messages SET turn_duration_ms=COALESCE(turn_duration_ms,?3)
            WHERE session_id=?1 AND id=?2 AND role IN ('user','coordination')",
                params![sid, message_id, duration_ms],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("The initiating turn message was not found.".into());
        }
        Ok(())
    }

    /// Keep tool start/progress/result snapshots in one ordered transcript row.
    pub fn tool_message(&self, sid: &str, tool_id: &str, content: &str) -> Result<()> {
        if tool_id.is_empty() || tool_id.len() > 512 || content.len() > 96 * 1024 {
            return Err("Tool activity exceeded its storage limit.".into());
        }
        self.db
            .prepare_cached(
                "INSERT INTO messages(session_id,role,content,created_at,tool_id)
          VALUES (?1,'tool',?2,?3,?4)
          ON CONFLICT(session_id,tool_id) DO UPDATE SET content=excluded.content",
            )
            .and_then(|mut statement| statement.execute(params![sid, content, now(), tool_id]))
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn finish_tools(&self, sid: &str) -> Result<()> {
        settle_unfinished_tools(
            &self.db,
            Some(sid),
            "\n\n[The turn ended before this tool reported a result.]",
            self.trackers_usable,
        )
    }

    /// Fetch one complete saved conversation message on demand. App-origin
    /// coordination prompts stay private even if older versions stored them as user text.
    pub fn message_content(&self, sid: &str, message_id: i64) -> Result<String> {
        let selected: Option<(String, String)> = self
            .db
            .query_row(
                "SELECT role,content FROM messages WHERE session_id=?1 AND id=?2",
                params![sid, message_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let (role, content) =
            selected.ok_or("This saved message does not belong to the selected task.")?;
        if !matches!(role.as_str(), "user" | "assistant")
            || (role == "user"
                && crate::architect::internal_turns::legacy_kind(self, sid, message_id, &content)?
                    .is_some())
        {
            return Err("Choose a saved user message or assistant response.".into());
        }
        Ok(content)
    }

    /// The next saved switch identifies the provider at this point, even when
    /// that switch lies outside the requested page or fork boundary. The partial
    /// index visits only handoffs and reads at most one small app-owned notice.
    pub(crate) fn provider_at_message(&self, sid: &str, message_id: i64) -> Result<String> {
        let current = self.session_provider(sid)?;
        let next: Option<String> = self.db
            .prepare_cached("SELECT substr(content,1,4096) FROM messages WHERE session_id=?1 AND role='handoff' AND id>?2 ORDER BY id LIMIT 1")
            .and_then(|mut statement| statement.query_row(params![sid, message_id], |row| row.get(0)))
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(next.as_deref().and_then(handoff_from_provider).unwrap_or(current))
    }

    pub fn messages(&self, sid: &str, before: Option<i64>) -> Result<Vec<Message>> {
        self.require_session(sid)?;
        // Read only the assistant preview before allocating the saved response.
        // BLOB substr preserves embedded NUL; four extra bytes keep any partial
        // UTF-8 code point beyond the existing byte-safe display truncation.
        let mut stmt=self.db.prepare_cached("SELECT m.id,m.session_id,m.role,CASE WHEN m.role='assistant' THEN COALESCE(substr(CAST(m.content AS BLOB),1,131076),X'') ELSE m.content END,m.created_at,m.turn_duration_ms,t.summary FROM messages m LEFT JOIN turn_changes t ON t.message_id=m.id WHERE m.session_id=?1 AND m.id<?2 ORDER BY m.id DESC LIMIT 100").map_err(|e|e.to_string())?;
        let rows = stmt
            .query_map(params![sid, before.unwrap_or(i64::MAX)], |r| {
                let role: String = r.get(2)?;
                let content = match r.get_ref(3)? {
                    rusqlite::types::ValueRef::Blob(bytes) if role == "assistant" => {
                        String::from_utf8_lossy(bytes).into_owned()
                    }
                    _ => r.get(3)?,
                };
                // The page budget counts the raw stored summary's length (`teamSources`
                // included), so the parsed changes are never serialized a second time.
                let summary: Option<String> = r.get(6)?;
                let metadata_bytes = summary.as_ref().map_or(0, String::len);
                let message = Message {
                    id: r.get(0)?,
                    session_id: r.get(1)?,
                    role,
                    content,
                    created_at: r.get(4)?,
                    turn_duration_ms: r.get(5)?,
                    author_provider: None,
                    coordination_kind: None,
                    turn_changes: summary
                        .map(|s| {
                            serde_json::from_str(&s).map_err(|e| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    6,
                                    rusqlite::types::Type::Text,
                                    Box::new(e),
                                )
                            })
                        })
                        .transpose()?,
                };
                Ok((message, metadata_bytes))
            })
            .map_err(|e| e.to_string())?;
        let mut page = Vec::new();
        let mut bytes = 0;
        for row in rows {
            let (mut message, metadata_bytes) = row.map_err(|e| e.to_string())?;
            crate::architect::internal_turns::project_message(self, &mut message)?;
            const NOTICE:&str="\n\n[Message preview truncated at 128 KiB. The provider retains the complete conversation.]";
            if message.content.len() > 128 * 1024 {
                let mut end = 128 * 1024 - NOTICE.len();
                while !message.content.is_char_boundary(end) {
                    end -= 1;
                }
                message.content.truncate(end);
                message.content.push_str(NOTICE);
            }
            if bytes + message.content.len() + metadata_bytes > 2 * 1024 * 1024 {
                break;
            }
            bytes += message.content.len() + metadata_bytes;
            page.push(message);
        }
        if let Some(last) = page.first() {
            let mut author = self.provider_at_message(sid, last.id)?;
            // Rows are newest first. An in-page switch changes the author of
            // the preceding responses without another database lookup.
            for message in &mut page {
                if message.role == "handoff" {
                    if let Some(from) = handoff_from_provider(&message.content) { author = from; }
                } else if message.role == "assistant" {
                    message.author_provider = Some(author.clone());
                }
            }
        }
        page.reverse();
        Ok(page)
    }
    pub fn message_page(&self, sid: &str, before: Option<i64>) -> Result<MessagePage> {
        let messages = self.messages(sid, before)?;
        // IDs are shared by every task, so the first ID alone cannot tell us
        // whether this task has earlier history. The session/id index keeps
        // this lookup bounded even when the returned page hit its byte limit.
        let has_older = match messages.first() {
            Some(first) => self
                .db
                .prepare_cached("SELECT EXISTS(SELECT 1 FROM messages WHERE session_id=?1 AND id<?2)")
                .and_then(|mut statement| statement.query_row(params![sid, first.id], |row| row.get(0)))
                .map_err(|e| e.to_string())?,
            None => false,
        };
        Ok(MessagePage {
            messages,
            has_older,
        })
    }
}

fn handoff_from_provider(content: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(content).ok()?;
    let from = value.get("fromProvider")?.as_str()?;
    let to = value.get("toProvider")?.as_str()?;
    value.get("summary")?.as_str()?;
    let known = |provider: &str| {
        matches!(
            provider,
            "claude"
                | "codex"
                | "kimi"
                | "opencode"
                | "glm"
                | "antigravity"
                | "grok"
                | "mimo" | "alibaba"
                | "pi"
                | "deepseek"
                | "commandcode" | "cline" | "kilo"
                | "omp"
                | "github-copilot"
                | "muse"
                | "devin"
                | "zcode"
                | "hermes"
                | "cursor"
        )
    };
    (known(from) && known(to)).then(|| from.to_owned())
}
