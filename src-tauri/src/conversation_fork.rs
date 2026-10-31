//! Local transcript forks start a fresh harness context in the source checkout.
use crate::{
    storage::{Session, Store},
    Result,
};
use rusqlite::params;

/// Copy an inclusive, persisted message boundary in one SQLite snapshot. This
/// deliberately shares the checkout, as the existing whole-task fork does; it
/// neither rewinds files nor creates another Git branch or project.
pub(crate) fn at_message(store: &Store, source_id: &str, message_id: i64) -> Result<Session> {
    copy(store, source_id, message_id, false)
}

/// Edit/rewind: the same fork, ending just before `message_id`, so the
/// mistaken prompt and everything after it stay only in the source.
pub(crate) fn before_message(store: &Store, source_id: &str, message_id: i64) -> Result<Session> {
    copy(store, source_id, message_id, true)
}

fn copy(store: &Store, source_id: &str, message_id: i64, exclusive: bool) -> Result<Session> {
    let transaction = store
        .db
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    let source = store.session(source_id)?;
    store.message_content(source_id, message_id)?;
    let boundary_provider = store.provider_at_message(source_id, message_id)?;
    // Resolve before writing so a missing worktree never becomes a main-folder
    // task. Team workers may also fork, but receive no team execution identity.
    store.workspace_root(&source.project_id, Some(source_id))?;
    let target = store.create_session(
        &source.project_id,
        &source.provider,
        &source.model,
        &source.mode,
    )?;
    let title: String = format!(
        "{} (fork)",
        source.title.chars().take(193).collect::<String>()
    );
    store.db.execute(
        "UPDATE sessions SET title=?2,worktree_path=?3,reasoning_effort=?4,codex_settings=?5,task_stage='in_progress',worktree_branch=?6 WHERE id=?1",
        params![target.id, title, source.worktree_path, source.reasoning_effort, source.codex_settings.map(|v| v.to_string()), source.worktree_branch],
    ).map_err(|e| e.to_string())?;
    {
        // Read raw storage rather than the paginated, display-truncated API.
        // Runtime durations and source checkout change records are not copied:
        // they can describe execution after the chosen message boundary.
        let mut query = store.db.prepare(
            "SELECT id,role,content,created_at FROM messages WHERE session_id=?1 AND id<=?2 AND role NOT IN ('internal','changes') ORDER BY id",
        ).map_err(|e| e.to_string())?;
        let rows = query
            .query_map(params![source_id, message_id - i64::from(exclusive)], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, mut role, mut content, created_at) = row.map_err(|e| e.to_string())?;
            if role == "user" {
                if let Some(kind) =
                    crate::architect::internal_turns::legacy_kind(store, source_id, id, &content)?
                {
                    content = crate::architect::internal_turns::encode(kind, &content)?;
                    role = "coordination".into();
                }
            }
            let tool_id = if role == "tool" {
                snapshot_tool(&mut content)
            } else {
                None
            };
            store.db.execute(
                "INSERT INTO messages(session_id,role,content,created_at,tool_id) VALUES(?1,?2,?3,?4,?5)",
                params![target.id, role, content, created_at, tool_id],
            ).map_err(|e| e.to_string())?;
        }
    }
    if boundary_provider != source.provider {
        // Later switches are outside the copied prefix. Retain that prefix's
        // final author while letting the fork continue with the chosen harness.
        let notice = serde_json::json!({
            "fromProvider": boundary_provider, "toProvider": source.provider,
            "summary": "Forked conversation. Earlier responses keep their original harness. The next message carries the saved conversation into the currently selected harness."
        });
        store.message(&target.id, "handoff", &notice.to_string())?;
    }
    store.db.execute(
        "UPDATE sessions SET task_description=COALESCE((SELECT content FROM messages WHERE session_id=?1 AND role='user' ORDER BY id LIMIT 1),'') WHERE id=?1",
        [&target.id],
    ).map_err(|e| e.to_string())?;
    // Keep this explicit even though no resume ID also triggers recovery. The
    // queued boundary survives a failed first start after a provider issues ID.
    crate::context_recovery::queue(store, &target.id)?;
    crate::session_titles::inherit(store, source_id, &target.id)?;
    let target = store.session(&target.id)?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(target)
}

fn snapshot_tool(content: &mut String) -> Option<String> {
    let mut value: serde_json::Value = serde_json::from_str(content).ok()?;
    if value["type"] != "tool_activity" || value["version"] != 1 {
        return None;
    }
    let id = format!("fork:{}", crate::storage::id());
    value["id"] = id.clone().into();
    if matches!(value["status"].as_str(), Some("running" | "waiting")) {
        value["status"] = "failed".into();
        value["output"] = format!(
            "{}\n[This tool was still running when the conversation was forked.]",
            value["output"].as_str().unwrap_or("")
        )
        .into();
    }
    *content = value.to_string();
    Some(id)
}

#[cfg(test)]
mod tests;
