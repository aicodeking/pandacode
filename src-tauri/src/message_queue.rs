//! Durable per-task message queues. Messages typed while an agent works are stored
//! here and delivered in order at a settled team wake or once the run finishes.
//! The app holds a queue after a restart, failure or stop until the user resumes it.
//! Steering sends into the running turn where the harness supports it.

use crate::{providers::RunInput, storage::Store, AppState, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex, PoisonError},
};
use tauri::{Emitter, State};

const MAX_PER_TASK: i64 = 50;
const MAX_ATTACHMENTS: usize = 1024 * 1024;

static HELD_QUEUES: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);

pub(crate) fn normalize_hold_reason(reason: Option<&str>) -> &str {
    match reason {
        Some(reason @ ("stopped" | "failed" | "limited" | "restart" | "reset")) => reason,
        _ => "stopped",
    }
}

pub fn set_queue_hold_state(session_id: &str, held: bool, reason: Option<&str>) {
    let mut queues = HELD_QUEUES.lock().unwrap_or_else(PoisonError::into_inner);
    if held {
        queues.insert(session_id.to_owned(), normalize_hold_reason(reason).to_owned());
    } else {
        queues.remove(session_id);
    }
}

#[allow(dead_code)]
pub fn set_queue_held(session_id: &str, held: bool) {
    set_queue_hold_state(session_id, held, None);
}

pub fn is_queue_held(session_id: &str) -> bool {
    HELD_QUEUES.lock().unwrap_or_else(PoisonError::into_inner).contains_key(session_id)
}

#[allow(dead_code)]
pub fn queue_hold_reason(session_id: &str) -> Option<String> {
    HELD_QUEUES.lock().unwrap_or_else(PoisonError::into_inner).get(session_id).cloned()
}

pub fn queue_holds_snapshot() -> HashMap<String, String> {
    HELD_QUEUES.lock().unwrap_or_else(PoisonError::into_inner).clone()
}

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
    if text.len() > crate::MESSAGE_LIMIT {
        return Err("Queued messages must be under 16 MiB.".into());
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
    let entry = withdraw(store, id)?;
    record_deliveries(&entry.session_id, 1);
    Ok(entry)
}

/// Takes the ready prefix in queue order. The caller records the delivery in the same
/// transaction and updates the in-memory delivery count once the transaction commits.
pub(crate) fn take_all_ready(
    transaction: &rusqlite::Transaction<'_>,
    session_id: &str,
    mut ready: impl FnMut(&QueuedMessage) -> bool,
) -> Result<Vec<QueuedMessage>> {
    if is_queue_held(session_id) {
        return Ok(Vec::new());
    }
    let blocked: bool = transaction.query_row(
        "SELECT archived OR (limited_at IS NOT NULL AND COALESCE(limited_until > ?2, 1)) FROM sessions WHERE id=?1",
        params![session_id, crate::storage::now()],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    if blocked {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    {
        let mut statement = transaction.prepare(&format!("SELECT {COLUMNS} FROM queued_messages WHERE session_id=?1 ORDER BY position,created_at")).map_err(|e| e.to_string())?;
        let rows = statement.query_map([session_id], row).map_err(|e| e.to_string())?;
        for entry in rows {
            let entry = entry.map_err(|e| e.to_string())?;
            if !ready(&entry) {
                break;
            }
            entries.push(entry);
        }
    }
    let mut delete = transaction.prepare_cached("DELETE FROM queued_messages WHERE id=?1").map_err(|e| e.to_string())?;
    for entry in &entries {
        delete.execute([&entry.id]).map_err(|e| e.to_string())?;
    }
    Ok(entries)
}

/// Removes and returns an entry without counting a queue delivery: a sender that queued an
/// entry and takes it straight back to send it itself (the run ended in between) is a direct
/// send, not the queue moving on.
pub(crate) fn withdraw(store: &Store, id: &str) -> Result<QueuedMessage> {
    let entry = get(store, id)?;
    remove(store, id)?;
    Ok(entry)
}

/// Round 22: removes an entry that left the queue for a run or on someone else's behalf (the
/// desktop's steer took it into the running turn, a shared channel stopped its assignment, an
/// agent removed it) and counts it like [`take`], so a phone's queue Undo held from before is
/// refused rather than putting an entry back into a queue that moved on. An entry already gone
/// is no error and counts nothing, as [`remove`]. The delete is one statement, so a racing
/// [`take`] and this never both count.
pub(crate) fn remove_delivered(store: &Store, id: &str) -> Result<()> {
    let session: Option<String> = store.db.query_row("DELETE FROM queued_messages WHERE id=?1 RETURNING session_id", [id], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
    if let Some(session) = session {
        record_deliveries(&session, 1);
    }
    Ok(())
}

/// How many entries each task's queue has handed out for delivery since launch. Taking queued
/// entries for delivery moves it up and [`restore`] (a failed delivery) moves it back down, so a prompt sent
/// straight to the task never does; PandaConnect's queue Undo compares it to refuse putting
/// an entry back once the queue moved on.
static DELIVERIES: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, u64>>> = std::sync::LazyLock::new(Default::default);

pub(crate) fn record_deliveries(session_id: &str, change: i64) {
    // A poisoned lock still holds a usable map.
    let mut counts = DELIVERIES.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let count = counts.entry(session_id.to_owned()).or_default();
    *count = count.saturating_add_signed(change);
}

/// The number of entries delivered from the task's queue since launch.
pub(crate) fn deliveries(session_id: &str) -> u64 {
    DELIVERIES.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(session_id).copied().unwrap_or(0)
}

/// Puts a taken entry back at the front of its queue after a failed delivery, keeping
/// its id, text, attachments and creation time. The queue limit does not apply: the
/// entry already held its place. The [`take`] it undoes no longer counts as a delivery.
pub(crate) fn restore(store: &Store, entry: &QueuedMessage) -> Result<QueuedMessage> {
    let restored = reinsert(store, entry)?;
    record_deliveries(&entry.session_id, -1);
    Ok(restored)
}

/// Puts a removed (never taken) entry back at the front of its queue, as [`restore`] does,
/// without touching the delivery count: PandaConnect's queue Undo.
pub(crate) fn reinsert(store: &Store, entry: &QueuedMessage) -> Result<QueuedMessage> {
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
pub async fn queue_list(
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<Vec<QueuedMessage>> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    list(&store, session_id.as_deref())
}

#[tauri::command]
pub async fn queue_holds() -> Result<HashMap<String, String>> {
    Ok(queue_holds_snapshot())
}

/// The session's harness and folder when `text` types a command, for the typed-command guard.
fn guard_target(
    store: &Store,
    session_id: &str,
    text: &str,
) -> Result<Option<(String, std::path::PathBuf)>> {
    if crate::skill_manager::typed_command(text).is_none() {
        return Ok(None);
    }
    let session = store.session(session_id)?;
    let cwd = match session.worktree_path {
        Some(path) => path,
        None => store.project(&session.project_id)?.path,
    };
    Ok(Some((session.provider, cwd.into())))
}

/// Refuses a steered or queued message that types a switched-off skill, with the error a new
/// turn would get: a running agent's harness expands `/name` itself, past every other switch.
/// The switches and the installed-skill scan are read off the async runtime.
async fn refuse_switched_off_skill(state: &AppState, session_id: &str, text: &str) -> Result<()> {
    let target = guard_target(
        &*state.store.lock().map_err(|e| e.to_string())?,
        session_id,
        text,
    )?;
    let Some((provider, cwd)) = target else {
        return Ok(());
    };
    let (session_id, text) = (session_id.to_owned(), text.to_owned());
    crate::blocking(move || {
        crate::skill_manager::check_session_prompt(&session_id, &provider, &cwd, &text)
    })
    .await
}

#[tauri::command]
pub async fn queue_add(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    text: String,
    attachments: Option<serde_json::Value>,
) -> Result<QueuedMessage> {
    refuse_switched_off_skill(&state, &session_id, &text).await?;
    let entry = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        add(
            &store,
            &session_id,
            &text,
            &attachments.unwrap_or_else(|| serde_json::json!([])),
        )?
    };
    let _ = app.emit("queue-changed", serde_json::json!({ "sessionId": session_id }));
    crate::headless::queue_changed(&app, &session_id);
    Ok(entry)
}

#[tauri::command]
pub async fn queue_update(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    text: String,
    attachments: Option<serde_json::Value>,
) -> Result<QueuedMessage> {
    if crate::skill_manager::typed_command(&text).is_some() {
        let session_id = get(&*state.store.lock().map_err(|e| e.to_string())?, &id)?.session_id;
        refuse_switched_off_skill(&state, &session_id, &text).await?;
    }
    let entry = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        update(
            &store,
            &id,
            &text,
            &attachments.unwrap_or_else(|| serde_json::json!([])),
        )?
    };
    let _ = app.emit("queue-changed", serde_json::json!({ "sessionId": entry.session_id }));
    Ok(entry)
}

#[tauri::command]
pub async fn queue_remove(app: tauri::AppHandle, state: State<'_, AppState>, id: String) -> Result<()> {
    let session_id = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let session_id = get(&store, &id).ok().map(|e| e.session_id);
        remove(&store, &id)?;
        session_id
    };
    if let Some(session_id) = session_id {
        let _ = app.emit("queue-changed", serde_json::json!({ "sessionId": session_id }));
    }
    Ok(())
}

/// The desktop composer's steer of a queued entry: once the running turn took it, the entry
/// leaves the queue as a delivery ([`remove_delivered`]); otherwise like `queue_remove`.
#[tauri::command]
pub async fn queue_take_steered(app: tauri::AppHandle, state: State<'_, AppState>, id: String) -> Result<()> {
    let session_id = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let session_id = get(&store, &id).ok().map(|e| e.session_id);
        remove_delivered(&store, &id)?;
        session_id
    };
    if let Some(session_id) = session_id {
        let _ = app.emit("queue-changed", serde_json::json!({ "sessionId": session_id }));
    }
    Ok(())
}

#[tauri::command]
pub async fn queue_reorder(app: tauri::AppHandle, state: State<'_, AppState>, session_id: String, ids: Vec<String>) -> Result<Vec<QueuedMessage>> {
    let entries = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        reorder(&store, &session_id, &ids)?
    };
    let _ = app.emit("queue-changed", serde_json::json!({ "sessionId": session_id }));
    Ok(entries)
}

#[tauri::command]
pub async fn queue_take(app: tauri::AppHandle, state: State<'_, AppState>, id: String) -> Result<QueuedMessage> {
    let entry = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        take(&store, &id)?
    };
    let _ = app.emit("queue-changed", serde_json::json!({ "sessionId": entry.session_id }));
    Ok(entry)
}

#[tauri::command]
pub async fn queue_restore(app: tauri::AppHandle, state: State<'_, AppState>, entry: QueuedMessage) -> Result<QueuedMessage> {
    let restored = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        restore(&store, &entry)?
    };
    let _ = app.emit("queue-changed", serde_json::json!({ "sessionId": restored.session_id }));
    Ok(restored)
}

/// Sends a message to the running agent without stopping it: into the current turn
/// where the harness allows (`mode: "live"`), otherwise as the next turn of the same
/// run (`"next-turn"`). Returns `{"steered":true,"id","mode"}`; `steer` agent events
/// with that id report `delivered`, or `failed` if the run ends first. On an error the
/// message should stay queued.
#[tauri::command]
pub async fn steer_task(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    text: String,
) -> Result<serde_json::Value> {
    let text = text.trim().to_owned();
    if text.is_empty() {
        return Err("Write a message to steer with.".into());
    }
    // A task on another computer steers there and saves the message in its own history.
    if let Some(reply) = crate::remote::route(
        &app,
        &state,
        &session_id,
        "task.steer",
        serde_json::json!({"text": text}),
    )
    .await?
    {
        return Ok(reply);
    }
    refuse_switched_off_skill(&state, &session_id, &text).await?;
    let reply = {
        let agents = crate::run_requests::lock_agents(&state.agents).map_err(|e| e.to_string())?;
        let agent = agents
            .get(&session_id)
            .ok_or("The agent is not running; the message stays queued.")?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        let id = uuid::Uuid::new_v4().to_string();
        agent
            .send(RunInput::Steer {
                id,
                text: text.clone(),
                reply: tx,
            })
            .map_err(|_| "The agent has stopped.".to_string())?;
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

/// A refused steer as an agent reads it. The "stays queued" wording is the composer's, whose
/// message really does stay queued; an agent's message went nowhere, whichever host refused it.
pub(crate) fn steer_refusal(error: &str, instead: &str) -> String {
    let error = error.trim_end_matches('.');
    let reason = error.strip_suffix("; the message stays queued").or_else(|| error.strip_suffix("; it stays queued")).unwrap_or(error);
    format!("Not delivered: {reason}. {instead}")
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
    fn queue_hold_reasons_are_normalized_and_cleared() {
        let session_id = crate::storage::id();
        for reason in ["failed", "limited", "restart", "reset", "stopped"] {
            set_queue_hold_state(&session_id, true, Some(reason));
            assert!(is_queue_held(&session_id));
            assert_eq!(queue_hold_reason(&session_id).as_deref(), Some(reason));
            assert_eq!(queue_holds_snapshot().get(&session_id).map(String::as_str), Some(reason));
        }

        for invalid in [Some("unknown"), Some(""), None] {
            set_queue_hold_state(&session_id, true, invalid);
            assert_eq!(queue_hold_reason(&session_id).as_deref(), Some("stopped"));
        }

        set_queue_hold_state(&session_id, false, Some("failed"));
        assert!(!is_queue_held(&session_id));
        assert_eq!(queue_hold_reason(&session_id), None);
        assert!(!queue_holds_snapshot().contains_key(&session_id));

        set_queue_held(&session_id, true);
        assert_eq!(queue_hold_reason(&session_id).as_deref(), Some("stopped"));
        set_queue_held(&session_id, false);
        assert!(!is_queue_held(&session_id));
    }

    #[test]
    fn batch_take_respects_usage_limits_and_stays_within_its_session() {
        let (store, task) = store();
        let parent = store.session(&task).unwrap().project_id;
        let other = store.create_session(&parent, "claude", "sonnet", "full").unwrap();
        let queued = add(&store, &task, "steering", &json!([])).unwrap();
        let elsewhere = add(&store, &other.id, "elsewhere", &json!([])).unwrap();
        for until in [None, Some(crate::storage::now() + 60_000)] {
            store.set_limited(&task, until).unwrap();
            let transaction = store.db.unchecked_transaction().unwrap();
            assert!(take_all_ready(&transaction, &task, |_| true).unwrap().is_empty());
            transaction.commit().unwrap();
            assert_eq!(list(&store, Some(&task)).unwrap(), std::slice::from_ref(&queued));
        }
        store.set_limited(&task, Some(crate::storage::now() - 1)).unwrap();
        let transaction = store.db.unchecked_transaction().unwrap();
        assert_eq!(take_all_ready(&transaction, &task, |_| true).unwrap(), [queued]);
        transaction.commit().unwrap();
        assert_eq!(list(&store, None).unwrap(), [elsewhere]);
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
        assert_eq!(deliveries(&task), 0);
        let taken = take(&store, &third.id).unwrap();
        assert_eq!(taken.text, "third");
        assert_eq!(deliveries(&task), 1, "a delivery is counted for its task");
        assert!(take(&store, &third.id).is_err(), "an entry is delivered once");
        assert_eq!(deliveries(&task), 1, "a failed take is not a delivery");
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

    /// Round 21: only real deliveries move the count queue Undo compares. A failed launch's
    /// restore undoes its take, a sender taking back its own just-queued entry (the run ended
    /// in between) counts nothing, and an Undo's reinsert leaves the count alone.
    #[test]
    fn only_real_deliveries_are_counted() {
        let (store, task) = store();
        let first = add(&store, &task, "first", &json!([])).unwrap();
        let taken = take(&store, &first.id).unwrap();
        assert_eq!(deliveries(&task), 1);
        restore(&store, &taken).unwrap();
        assert_eq!(deliveries(&task), 0, "a failed launch is not a delivery");
        assert!(restore(&store, &taken).is_err());
        assert_eq!(deliveries(&task), 0, "a refused restore changes nothing");
        let raced = add(&store, &task, "raced", &json!([])).unwrap();
        assert_eq!(withdraw(&store, &raced.id).unwrap().text, "raced");
        assert_eq!(deliveries(&task), 0, "taking back a just-queued entry to send it directly is not a queue delivery");
        assert!(withdraw(&store, &raced.id).is_err(), "withdrawn once");
        let removed = list(&store, Some(&task)).unwrap().remove(0);
        remove(&store, &removed.id).unwrap();
        reinsert(&store, &removed).unwrap();
        assert_eq!(deliveries(&task), 0, "an Undo's reinsert is not a delivery either");
        take(&store, &first.id).unwrap();
        assert_eq!(deliveries(&task), 1);
        // The race fallbacks never count, and the desktop's failed launch goes through restore.
        let host = include_str!("remote/host.rs");
        let deliver = &host[host.find("async fn deliver_prompt").unwrap()..];
        let deliver = &deliver[..deliver.find("\n}\n").unwrap()];
        assert!(deliver.contains("message_queue::withdraw(") && !deliver.contains("message_queue::take("));
        let tools = include_str!("remote/methods/tools.rs");
        assert!(!tools.contains("message_queue::take("));
        let source = include_str!("message_queue.rs");
        let command = &source[source.find("pub async fn queue_restore").unwrap()..];
        assert!(command[..command.find("\n}\n").unwrap()].contains("restore(&store, &entry)"));
        let composer = include_str!("remote/methods/composer.rs");
        assert!(composer.contains("message_queue::reinsert(store, &held.entry)") && !composer.contains("message_queue::restore("));
    }

    /// Round 22: a steered entry (the desktop's `queue_take_steered`), a stopped channel
    /// assignment and an agent's removal leave the queue as deliveries; a plain remove does not.
    #[test]
    fn steered_and_other_takes_count_as_deliveries() {
        let (store, task) = store();
        let first = add(&store, &task, "first", &json!([])).unwrap();
        let second = add(&store, &task, "second", &json!([])).unwrap();
        remove_delivered(&store, &first.id).unwrap();
        assert_eq!(deliveries(&task), 1);
        assert_eq!(list(&store, Some(&task)).unwrap().iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), [second.id.as_str()]);
        remove_delivered(&store, &first.id).expect("already gone is fine, as remove");
        assert_eq!(deliveries(&task), 1, "and counts nothing");
        remove(&store, &second.id).unwrap();
        assert_eq!(deliveries(&task), 1, "a user's own remove is not a delivery");
        let main = include_str!("../../src/main.ts");
        let steer = &main[main.find("async function steerQueued(").unwrap()..];
        let steer = &steer[..steer.find("\n}\n").unwrap()];
        assert!(steer.contains("call('queue_take_steered', { id })") && !steer.contains("'queue_remove'"), "the desktop steer counts");
        assert!(include_str!("lib.rs").contains("message_queue::queue_take_steered,"));
        let channels = include_str!("bots/shared_channels.rs");
        assert!(channels.contains("message_queue::remove_delivered(&store,&queued.id)") && !channels.contains("message_queue::remove(&store"));
        let tools = include_str!("agent_tools.rs");
        assert!(tools.contains("crate::message_queue::remove_delivered(&store, &id)?;") && !tools.contains("crate::message_queue::remove(&store"));
    }

    #[test]
    fn steered_and_queued_messages_refuse_a_typed_switched_off_skill_on_claude_and_acp() {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let folder = std::env::temp_dir();
        let project = store.add_project(&folder).unwrap();
        for provider in ["claude", "kimi"] {
            let task = store
                .create_session(&project.id, provider, "default", "ask")
                .unwrap();
            // Plain text never reaches the switches.
            assert_eq!(
                guard_target(&store, &task.id, "deploy it please").unwrap(),
                None
            );
            let (harness, cwd) = guard_target(&store, &task.id, "/deploy staging")
                .unwrap()
                .unwrap();
            assert_eq!(
                (harness.as_str(), cwd.as_path()),
                (provider, Path::new(&project.path))
            );
            let check = |text: &str| {
                crate::skill_manager::check_session_prompt_with(
                    &harness,
                    text,
                    || std::collections::BTreeSet::from(["deploy".into()]),
                    || std::collections::BTreeSet::from(["deploy".into()]),
                )
            };
            assert_eq!(
                check("/deploy staging").unwrap_err(),
                format!(
                    "deploy is switched off in {}.",
                    crate::skill_manager::SKILLS_SETTINGS
                ),
                "{provider}"
            );
            assert!(check("/other").is_ok(), "{provider}");
        }
        assert!(guard_target(&store, "missing", "/deploy").is_err());
    }

    #[test]
    fn queues_validate_input_and_follow_their_task() {
        let (store, task) = store();
        assert!(add(&store, &task, "   ", &json!([])).is_err());
        assert!(add(&store, &task, "", &json!({"not":"a list"})).is_err());
        assert!(add(&store, &task, &"x".repeat(crate::MESSAGE_LIMIT + 1), &json!([])).is_err());
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
