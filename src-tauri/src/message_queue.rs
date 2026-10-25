//! Durable per-task message queues. Messages typed while an agent works are stored
//! here and delivered in order once the run finishes; the app holds a queue after a
//! restart, a failure or a stop until the user resumes it. Steering sends a message
//! into the running turn instead, where the harness supports it.

use crate::{providers::RunInput, storage::Store, AppState, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

const MAX_PER_TASK: i64 = 50;
const MAX_TEXT: usize = 128 * 1024;
const MAX_ATTACHMENTS: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessage {
    pub id: String,
    pub session_id: String,
    pub position: i64,
    pub text: String,
    /// Attachments as the composer described them, opaque to native code.
    pub attachments: serde_json::Value,
    pub created_at: i64,
    pub updated_at: i64,
}

fn validate(text: &str, attachments: &serde_json::Value) -> Result<String> {
    let encoded = serde_json::to_string(attachments).map_err(|e| e.to_string())?;
    if !attachments.is_array() || encoded.len() > MAX_ATTACHMENTS {
        return Err("Queued attachments are invalid or too large.".into());
    }
    if text.len() > MAX_TEXT {
        return Err("Queued messages must be under 128 KiB.".into());
    }
    if text.trim().is_empty() && attachments.as_array().is_some_and(Vec::is_empty) {
        return Err("Write a message or add an attachment to queue.".into());
    }
    Ok(encoded)
}

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<QueuedMessage> {
    Ok(QueuedMessage {
        id: r.get(0)?,
        session_id: r.get(1)?,
        position: r.get(2)?,
        text: r.get(3)?,
        attachments: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_else(|_| serde_json::json!([])),
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
    })
}

const COLUMNS: &str = "id,session_id,position,text,attachments,created_at,updated_at";

pub(crate) fn list(store: &Store, session_id: Option<&str>) -> Result<Vec<QueuedMessage>> {
    let mut statement = store
        .db
        .prepare(&format!("SELECT {COLUMNS} FROM queued_messages WHERE ?1 IS NULL OR session_id=?1 ORDER BY session_id,position,created_at"))
        .map_err(|e| e.to_string())?;
    let rows = statement.query_map([session_id], row).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

fn get(store: &Store, id: &str) -> Result<QueuedMessage> {
    store
        .db
        .query_row(&format!("SELECT {COLUMNS} FROM queued_messages WHERE id=?1"), [id], row)
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "This queued message was already sent or removed.".into())
}

pub(crate) fn add(store: &Store, session_id: &str, text: &str, attachments: &serde_json::Value) -> Result<QueuedMessage> {
    store.session(session_id)?;
    store.ensure_writable(session_id)?;
    let encoded = validate(text, attachments)?;
    let count: i64 = store.db.query_row("SELECT COUNT(*) FROM queued_messages WHERE session_id=?1", [session_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if count >= MAX_PER_TASK {
        return Err(format!("A task can queue up to {MAX_PER_TASK} messages."));
    }
    let id = crate::storage::id();
    let now = crate::storage::now();
    store
        .db
        .execute(
            "INSERT INTO queued_messages(id,session_id,position,text,attachments,created_at,updated_at) VALUES(?1,?2,(SELECT COALESCE(MAX(position),-1)+1 FROM queued_messages WHERE session_id=?2),?3,?4,?5,?5)",
            params![id, session_id, text, encoded, now],
        )
        .map_err(|e| e.to_string())?;
    get(store, &id)
}

pub(crate) fn update(store: &Store, id: &str, text: &str, attachments: &serde_json::Value) -> Result<QueuedMessage> {
    let encoded = validate(text, attachments)?;
    let changed = store
        .db
        .execute("UPDATE queued_messages SET text=?2,attachments=?3,updated_at=?4 WHERE id=?1", params![id, text, encoded, crate::storage::now()])
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("This queued message was already sent or removed.".into());
    }
    get(store, id)
}

pub(crate) fn remove(store: &Store, id: &str) -> Result<()> {
    store.db.execute("DELETE FROM queued_messages WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Reorders a task's queue to `ids`, which must name exactly its current entries.
pub(crate) fn reorder(store: &Store, session_id: &str, ids: &[String]) -> Result<Vec<QueuedMessage>> {
    let transaction = store.db.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut current: Vec<String> = list(store, Some(session_id))?.into_iter().map(|entry| entry.id).collect();
    let mut requested = ids.to_vec();
    current.sort();
    requested.sort();
    if current != requested {
        return Err("The queue changed. Try reordering again.".into());
    }
    for (position, id) in ids.iter().enumerate() {
        store.db.execute("UPDATE queued_messages SET position=?2 WHERE id=?1", params![id, position as i64]).map_err(|e| e.to_string())?;
    }
    transaction.commit().map_err(|e| e.to_string())?;
    list(store, Some(session_id))
}

/// Removes and returns an entry for delivery, so it can only ever be sent once.
pub(crate) fn take(store: &Store, id: &str) -> Result<QueuedMessage> {
    let entry = get(store, id)?;
    remove(store, id)?;
    Ok(entry)
}

/// Puts a taken entry back at the front of its queue after a failed delivery, keeping
/// its id, text, attachments and creation time. The queue limit does not apply: the
/// entry already held its place.
pub(crate) fn restore(store: &Store, entry: &QueuedMessage) -> Result<QueuedMessage> {
    store.session(&entry.session_id)?;
    let encoded = validate(&entry.text, &entry.attachments)?;
    store
        .db
        .execute(
            "INSERT INTO queued_messages(id,session_id,position,text,attachments,created_at,updated_at) VALUES(?1,?2,(SELECT COALESCE(MIN(position),1)-1 FROM queued_messages WHERE session_id=?2),?3,?4,?5,?6)",
            params![entry.id, entry.session_id, entry.text, encoded, entry.created_at, crate::storage::now()],
        )
        .map_err(|e| e.to_string())?;
    get(store, &entry.id)
}

#[tauri::command]
pub async fn queue_list(state: State<'_, AppState>, session_id: Option<String>) -> Result<Vec<QueuedMessage>> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    list(&store, session_id.as_deref())
}

#[tauri::command]
pub async fn queue_add(state: State<'_, AppState>, session_id: String, text: String, attachments: Option<serde_json::Value>) -> Result<QueuedMessage> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    add(&store, &session_id, &text, &attachments.unwrap_or_else(|| serde_json::json!([])))
}

#[tauri::command]
pub async fn queue_update(state: State<'_, AppState>, id: String, text: String, attachments: Option<serde_json::Value>) -> Result<QueuedMessage> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    update(&store, &id, &text, &attachments.unwrap_or_else(|| serde_json::json!([])))
}

#[tauri::command]
pub async fn queue_remove(state: State<'_, AppState>, id: String) -> Result<()> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    remove(&store, &id)
}

#[tauri::command]
pub async fn queue_reorder(state: State<'_, AppState>, session_id: String, ids: Vec<String>) -> Result<Vec<QueuedMessage>> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    reorder(&store, &session_id, &ids)
}

#[tauri::command]
pub async fn queue_take(state: State<'_, AppState>, id: String) -> Result<QueuedMessage> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    take(&store, &id)
}

#[tauri::command]
pub async fn queue_restore(state: State<'_, AppState>, entry: QueuedMessage) -> Result<QueuedMessage> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    restore(&store, &entry)
}

/// Sends a message to the running agent without stopping it: into the current turn
/// where the harness allows (`mode: "live"`), otherwise as the next turn of the same
/// run (`"next-turn"`). Returns `{"steered":true,"id","mode"}`; `steer` agent events
/// with that id report `delivered`, or `failed` if the run ends first. On an error the
/// message should stay queued.
#[tauri::command]
pub async fn steer_task(app: tauri::AppHandle, state: State<'_, AppState>, session_id: String, text: String) -> Result<serde_json::Value> {
    let text = text.trim().to_owned();
    if text.is_empty() {
        return Err("Write a message to steer with.".into());
    }
    state.store.lock().map_err(|e| e.to_string())?.ensure_writable(&session_id)?;
    // A task on another computer steers there and saves the message in its own history.
    if let Some(reply) = crate::remote::route(&app, &state, &session_id, "task.steer", serde_json::json!({"text": text})).await? {
        return Ok(reply);
    }
    let reply = {
        let agents = state.agents.lock().map_err(|e| e.to_string())?;
        let agent = agents.get(&session_id).ok_or("The agent is not running; the message stays queued.")?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        let id = uuid::Uuid::new_v4().to_string();
        agent.send(RunInput::Steer { id, text: text.clone(), reply: tx }).map_err(|_| "The agent has stopped.".to_string())?;
        rx
    };
    let reply = tokio::time::timeout(std::time::Duration::from_secs(15), reply)
        .await
        .map_err(|_| "The agent did not accept the message in time; it stays queued.".to_owned())?
        .map_err(|_| "The agent stopped before taking the message.".to_owned())??;
    // ponytail: saved on acceptance; a steer later reported `failed` stays in the transcript.
    state.store.lock().map_err(|e| e.to_string())?.message(&session_id, "user", &text)?;
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::Path;

    fn store() -> (Store, String) {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let task = store.create_session(&project.id, "claude", "sonnet", "full").unwrap();
        (store, task.id)
    }

    #[test]
    fn queues_keep_order_and_survive_reorder_edit_and_take() {
        let (store, task) = store();
        let first = add(&store, &task, "first", &json!([])).unwrap();
        let second = add(&store, &task, "second", &json!([{"kind":"image","id":"abc"}])).unwrap();
        let third = add(&store, &task, "third", &json!([])).unwrap();
        assert_eq!(list(&store, Some(&task)).unwrap().iter().map(|e| e.text.as_str()).collect::<Vec<_>>(), ["first", "second", "third"]);
        let order = reorder(&store, &task, &[third.id.clone(), first.id.clone(), second.id.clone()]).unwrap();
        assert_eq!(order.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(), ["third", "first", "second"]);
        assert!(reorder(&store, &task, std::slice::from_ref(&first.id)).is_err(), "a partial order is refused");
        let edited = update(&store, &second.id, "second, edited", &json!([])).unwrap();
        assert_eq!(edited.attachments, json!([]));
        let taken = take(&store, &third.id).unwrap();
        assert_eq!(taken.text, "third");
        assert!(take(&store, &third.id).is_err(), "an entry is delivered once");
        assert_eq!(list(&store, None).unwrap().len(), 2);
        // A new message goes to the end even after reordering.
        assert_eq!(add(&store, &task, "fourth", &json!([])).unwrap().position, 3);
    }

    #[test]
    fn a_failed_delivery_restores_the_entry_to_the_front() {
        let (store, task) = store();
        let first = add(&store, &task, "first", &json!([{"kind":"image","id":"abc"}])).unwrap();
        add(&store, &task, "second", &json!([])).unwrap();
        let taken = take(&store, &first.id).unwrap();
        add(&store, &task, "third", &json!([])).unwrap();
        let restored = restore(&store, &taken).unwrap();
        assert_eq!((restored.id.as_str(), restored.attachments.clone(), restored.created_at), (first.id.as_str(), json!([{"kind":"image","id":"abc"}]), first.created_at));
        assert_eq!(list(&store, Some(&task)).unwrap().iter().map(|e| e.text.as_str()).collect::<Vec<_>>(), ["first", "second", "third"]);
        assert!(restore(&store, &restored).is_err(), "an entry still queued is not duplicated");
        // After a reorder it still lands first, and new messages still go last.
        let taken = take(&store, &first.id).unwrap();
        let ids: Vec<String> = list(&store, Some(&task)).unwrap().into_iter().rev().map(|e| e.id).collect();
        reorder(&store, &task, &ids).unwrap();
        restore(&store, &taken).unwrap();
        assert_eq!(list(&store, Some(&task)).unwrap().iter().map(|e| e.text.as_str()).collect::<Vec<_>>(), ["first", "third", "second"]);
        assert_eq!(add(&store, &task, "fourth", &json!([])).unwrap().position, 2);
    }

    #[test]
    fn queues_validate_input_and_follow_their_task() {
        let (store, task) = store();
        assert!(add(&store, &task, "   ", &json!([])).is_err());
        assert!(add(&store, &task, "", &json!({"not":"a list"})).is_err());
        assert!(add(&store, &task, &"x".repeat(MAX_TEXT + 1), &json!([])).is_err());
        assert!(add(&store, "missing", "hello", &json!([])).is_err());
        assert!(add(&store, &task, "", &json!([{"kind":"document"}])).is_ok(), "an attachment alone can be queued");
        for i in 1..MAX_PER_TASK {
            add(&store, &task, &format!("m{i}"), &json!([])).unwrap();
        }
        assert!(add(&store, &task, "one too many", &json!([])).is_err());
        store.db.execute("DELETE FROM sessions WHERE id=?1", [&task]).unwrap();
        assert!(list(&store, None).unwrap().is_empty(), "deleting a task removes its queue");
    }
}
