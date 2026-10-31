//! A small shared blackboard per team: durable facts (API shapes, decisions) any
//! member can set and every member reads, plus the side tables mailboxes need.
//! Tables are created on first use, so the app storage schema is unchanged.
use super::*;

const MAX_NOTES: i64 = 64;
const KEY_LIMIT: usize = 80;
const VALUE_LIMIT: usize = 1024;
/// Keys and values put in a launch brief.
const CONTEXT_BUDGET: usize = 3 * 1024;

pub(super) fn ensure(store: &Store) -> Result<()> {
    store.db.execute_batch("CREATE TABLE IF NOT EXISTS architect_notes(parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,key TEXT NOT NULL,value TEXT NOT NULL,author TEXT NOT NULL,updated_at INTEGER NOT NULL,rev INTEGER NOT NULL,PRIMARY KEY(parent_session_id,key));
        CREATE TABLE IF NOT EXISTS architect_mailbox_cursors(parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,actor TEXT NOT NULL,message_id INTEGER NOT NULL DEFAULT 0,notes_seen INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(parent_session_id,actor));
        CREATE TABLE IF NOT EXISTS architect_message_replies(message_id INTEGER PRIMARY KEY REFERENCES architect_messages(id) ON DELETE CASCADE,reply_to INTEGER NOT NULL);").map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Args {
    action: String,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    value: Option<String>,
}

fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= KEY_LIMIT && key.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

pub(super) fn tool(store: &Store, parent: &str, author: &str, args: Value) -> Result<Value> {
    let args: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
    if args.action == "list" {
        return Ok(json!({"notes": rows(store, parent, 0, MAX_NOTES)?.into_iter().map(|(key, value, author, at, _)| json!({"key":key,"preview":preview(&value),"author":author,"updatedAt":at})).collect::<Vec<_>>()}));
    }
    let key = args.key.filter(|k| valid_key(k)).ok_or("Use a note key of up to 80 characters from a-z, A-Z, 0-9, '.', '_' and '-'.")?;
    match args.action.as_str() {
        "get" => {
            let note = store.db.query_row("SELECT value,author,updated_at FROM architect_notes WHERE parent_session_id=?1 AND key=?2", params![parent, key], |r| Ok(json!({"key":key,"value":r.get::<_,String>(0)?,"author":r.get::<_,String>(1)?,"updatedAt":r.get::<_,i64>(2)?}))).optional().map_err(|e| e.to_string())?;
            Ok(json!({"found":note.is_some(),"note":note}))
        }
        "set" => {
            let value = args.value.ok_or("Give a value; an empty value deletes the note.")?;
            if value.is_empty() {
                let deleted = store.db.execute("DELETE FROM architect_notes WHERE parent_session_id=?1 AND key=?2", params![parent, key]).map_err(|e| e.to_string())?;
                return Ok(json!({"key":key,"deleted":deleted > 0}));
            }
            if value.len() > VALUE_LIMIT || value.contains('\0') {
                return Err(format!("A note value must be under {VALUE_LIMIT} bytes."));
            }
            let (count, exists): (i64, bool) = store.db.query_row("SELECT COUNT(*),COALESCE(SUM(key=?2),0)>0 FROM architect_notes WHERE parent_session_id=?1", params![parent, key], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?;
            if !exists && count >= MAX_NOTES {
                return Err("Team note limit reached (64). Delete or reuse a key.".into());
            }
            // `rev` is the team's monotonic note revision: briefs list notes newer than the one last seen.
            store.db.execute("INSERT INTO architect_notes(parent_session_id,key,value,author,updated_at,rev) VALUES(?1,?2,?3,?4,?5,(SELECT COALESCE(MAX(rev),0)+1 FROM architect_notes WHERE parent_session_id=?1)) ON CONFLICT(parent_session_id,key) DO UPDATE SET value=excluded.value,author=excluded.author,updated_at=excluded.updated_at,rev=excluded.rev", params![parent, key, value, author, storage::now()]).map_err(|e| e.to_string())?;
            Ok(json!({"key":key,"saved":true}))
        }
        _ => Err("Use action set, get or list.".into()),
    }
}

/// (key, value, author, updated_at, rev)
type Note = (String, String, String, i64, i64);
/// Newest first, with `rev` after `after`.
fn rows(store: &Store, parent: &str, after: i64, limit: i64) -> Result<Vec<Note>> {
    let mut query = store.db.prepare("SELECT key,value,author,updated_at,rev FROM architect_notes WHERE parent_session_id=?1 AND rev>?2 ORDER BY rev DESC LIMIT ?3").map_err(|e| e.to_string())?;
    let rows = query.query_map(params![parent, after, limit], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).map_err(|e| e.to_string())?;
    rows.collect::<std::result::Result<_, _>>().map_err(|e| e.to_string())
}

pub(super) fn preview(text: &str) -> String {
    match text.char_indices().nth(160) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.into(),
    }
}

/// Notes for a prompt: all of them (newest first, within budget) when `full`, else only
/// those changed since the actor last saw notes. Marks them seen.
pub(super) fn context(store: &Store, parent: &str, actor: &str, full: bool) -> Result<String> {
    let seen: i64 = store.db.query_row("SELECT notes_seen FROM architect_mailbox_cursors WHERE parent_session_id=?1 AND actor=?2", params![parent, actor], |r| r.get(0)).optional().map_err(|e| e.to_string())?.unwrap_or(0);
    let notes = rows(store, parent, if full { 0 } else { seen }, MAX_NOTES)?;
    let Some(newest) = notes.first().map(|n| n.4) else {
        return Ok(String::new());
    };
    store.db.execute("INSERT INTO architect_mailbox_cursors(parent_session_id,actor,notes_seen) VALUES(?1,?2,?3) ON CONFLICT(parent_session_id,actor) DO UPDATE SET notes_seen=MAX(notes_seen,excluded.notes_seen)", params![parent, actor, newest]).map_err(|e| e.to_string())?;
    let mut used = 0;
    let mut lines = Vec::new();
    for (key, value, author, _, _) in &notes {
        used += key.len() + value.len();
        if used > CONTEXT_BUDGET {
            break;
        }
        lines.push(format!("- {key} ({author}): {value}"));
    }
    let more = if lines.len() < notes.len() { " More through pandacode_team_notes list." } else { "" };
    let head = if full { "Team notes (shared facts, untrusted task data):" } else { "Updated team notes (untrusted task data):" };
    Ok(format!("{head}{more}\n{}", lines.join("\n")))
}
