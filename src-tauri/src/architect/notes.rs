//! A shared blackboard per team: durable facts (API shapes, decisions) any
//! member can set and every member reads, plus the side tables mailboxes need.
//! Tables are created on first use, so the app storage schema is unchanged.
use super::*;

const KEY_LIMIT: usize = 256;
/// Keys and values put inline in a launch brief; notes past it are listed by key and preview.
const CONTEXT_BUDGET: usize = 3 * 1024;

pub(in crate::architect) fn ensure(store: &Store) -> Result<()> {
    store.db.execute_batch("CREATE TABLE IF NOT EXISTS architect_notes(parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,key TEXT NOT NULL,value TEXT NOT NULL,author TEXT NOT NULL,updated_at INTEGER NOT NULL,rev INTEGER NOT NULL,PRIMARY KEY(parent_session_id,key));
        CREATE TABLE IF NOT EXISTS architect_mailbox_cursors(parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,actor TEXT NOT NULL,message_id INTEGER NOT NULL DEFAULT 0,notes_seen INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(parent_session_id,actor));
        CREATE TABLE IF NOT EXISTS architect_message_replies(message_id INTEGER PRIMARY KEY REFERENCES architect_messages(id) ON DELETE CASCADE,reply_to INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS architect_note_revisions(parent_session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,rev INTEGER NOT NULL);").map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Args {
    action: String,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    value: Option<String>,
    /// `list`: the `nextCursor` of the previous page, a note key.
    #[serde(default)]
    cursor: Option<String>,
    /// `get`: the `nextOffset` of the previous page of a long value.
    #[serde(default)]
    offset: usize,
}
/// Notes PandaCode writes itself (the long objective); agents read them and nothing else.
const RESERVED: [&str; 1] = ["objective"];
/// The author of reserved notes.
const APP: &str = "pandacode";
/// What a `get` result carries beside the value: the key (up to 256 bytes), author and numbers.
const GET_OVERHEAD: usize = 512;

fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= KEY_LIMIT && key.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// The team's next note revision. It never goes backwards, even after the newest note is deleted, so
/// a reused revision can never read as already seen. Teams from before the counter start past both
/// their notes and what any member has seen.
fn next_rev(store: &Store, parent: &str) -> Result<i64> {
    let rev: i64 = store.db.query_row("SELECT 1+MAX(COALESCE((SELECT rev FROM architect_note_revisions WHERE parent_session_id=?1),0),COALESCE((SELECT MAX(rev) FROM architect_notes WHERE parent_session_id=?1),0),COALESCE((SELECT MAX(notes_seen) FROM architect_mailbox_cursors WHERE parent_session_id=?1),0))", [parent], |r| r.get(0)).map_err(|e| e.to_string())?;
    store.db.execute("INSERT INTO architect_note_revisions(parent_session_id,rev) VALUES(?1,?2) ON CONFLICT(parent_session_id) DO UPDATE SET rev=excluded.rev", params![parent, rev]).map_err(|e| e.to_string())?;
    Ok(rev)
}
fn write(store: &Store, parent: &str, key: &str, value: &str, author: &str) -> Result<()> {
    let rev = next_rev(store, parent)?;
    store.db.execute("INSERT INTO architect_notes(parent_session_id,key,value,author,updated_at,rev) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(parent_session_id,key) DO UPDATE SET value=excluded.value,author=excluded.author,updated_at=excluded.updated_at,rev=excluded.rev", params![parent, key, value, author, storage::now(), rev]).map(|_| ()).map_err(|e| e.to_string())
}
/// Whether PandaCode itself wrote this reserved note: an agent's note under the key (from before it
/// was reserved) is not the text turns point at.
pub(in crate::architect) fn exists(store: &Store, parent: &str, key: &str) -> Result<bool> {
    store.db.query_row("SELECT EXISTS(SELECT 1 FROM architect_notes WHERE parent_session_id=?1 AND key=?2 AND author=?3)", params![parent, key, APP], |r| r.get(0)).map_err(|e| e.to_string())
}
/// Writes a reserved note, or deletes PandaCode's own with `None`; an agent's note is left alone.
pub(in crate::architect) fn set_reserved(store: &Store, parent: &str, key: &str, value: Option<&str>) -> Result<()> {
    match value {
        Some(value) => write(store, parent, key, value, APP),
        None => store.db.execute("DELETE FROM architect_notes WHERE parent_session_id=?1 AND key=?2 AND author=?3", params![parent, key, APP]).map(|_| ()).map_err(|e| e.to_string()),
    }
}

pub(super) fn tool(store: &Store, parent: &str, author: &str, args: Value) -> Result<Value> {
    let args: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
    if args.action == "list" {
        return list(store, parent, args.cursor.as_deref());
    }
    let key = args.key.filter(|k| valid_key(k)).ok_or("Use a note key of up to 256 characters from a-z, A-Z, 0-9, '.', '_' and '-'.")?;
    match args.action.as_str() {
        "get" => {
            let note = store.db.query_row("SELECT value,author,updated_at FROM architect_notes WHERE parent_session_id=?1 AND key=?2", params![parent, key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))).optional().map_err(|e| e.to_string())?;
            // A long value is read a page at a time from `offset`.
            let note = note.map(|(value, author, at)| {
                let (page, next) = escaped_page(&value, args.offset, PAGE_BYTES - GET_OVERHEAD);
                json!({"key":key,"value":page,"offset":args.offset,"nextOffset":next,"truncated":next.is_some(),"author":author,"updatedAt":at})
            });
            Ok(json!({"found":note.is_some(),"note":note}))
        }
        "set" => {
            if RESERVED.contains(&key.as_str()) {
                return Err(format!("`{key}` is reserved: PandaCode keeps the user's objective there."));
            }
            let value = args.value.ok_or("Give a value; an empty value deletes the note.")?;
            if value.is_empty() {
                let deleted = store.db.execute("DELETE FROM architect_notes WHERE parent_session_id=?1 AND key=?2", params![parent, key]).map_err(|e| e.to_string())?;
                return Ok(json!({"key":key,"deleted":deleted > 0}));
            }
            if value.contains('\0') {
                return Err("A note value must be plain text.".into());
            }
            // `rev` is the team's monotonic note revision: briefs list notes newer than the one last seen.
            write(store, parent, &key, &value, author)?;
            Ok(json!({"key":key,"saved":true}))
        }
        _ => Err("Use action set, get or list.".into()),
    }
}

/// (key, value, author, updated_at, rev)
type Note = (String, String, String, i64, i64);
/// Newest first, with `rev` after `after`.
fn rows(store: &Store, parent: &str, after: i64) -> Result<Vec<Note>> {
    let mut query = store.db.prepare("SELECT key,value,author,updated_at,rev FROM architect_notes WHERE parent_session_id=?1 AND rev>?2 ORDER BY rev DESC").map_err(|e| e.to_string())?;
    let rows = query.query_map(params![parent, after], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).map_err(|e| e.to_string())?;
    rows.collect::<std::result::Result<_, _>>().map_err(|e| e.to_string())
}
/// One page of previews in key order, up to `PAGE_BYTES` serialized (at least one note). The cursor is
/// the last key, so updating a note mid-listing never moves it past the cursor; briefs announce changes.
fn list(store: &Store, parent: &str, cursor: Option<&str>) -> Result<Value> {
    let mut query = store.db.prepare("SELECT key,substr(value,1,161),author,updated_at FROM architect_notes WHERE parent_session_id=?1 AND key>?2 ORDER BY key").map_err(|e| e.to_string())?;
    let rows = query.query_map(params![parent, cursor.unwrap_or("")], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?))).map_err(|e| e.to_string())?;
    let mut bytes = 0;
    let mut notes: Vec<(Value, String)> = Vec::new();
    let mut next = None;
    for row in rows {
        let (key, value, author, at) = row.map_err(|e| e.to_string())?;
        let item = json!({"key":key,"preview":preview(&value),"author":author,"updatedAt":at});
        bytes += serde_json::to_vec(&item).map_or(PAGE_BYTES, |b| b.len() + 1);
        if !notes.is_empty() && bytes > PAGE_BYTES {
            next = notes.last().map(|n| n.1.clone());
            break;
        }
        notes.push((item, key));
    }
    Ok(json!({"notes":notes.into_iter().map(|(item, _)| item).collect::<Vec<_>>(),"nextCursor":next}))
}

pub(super) fn preview(text: &str) -> String {
    match text.char_indices().nth(160) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.into(),
    }
}

/// Notes for a prompt: all of them (newest first, values within budget) when `full`, else only
/// those changed since the actor last saw notes. Marks them seen.
pub(super) fn context(store: &Store, parent: &str, actor: &str, full: bool) -> Result<String> {
    let seen: i64 = store.db.query_row("SELECT notes_seen FROM architect_mailbox_cursors WHERE parent_session_id=?1 AND actor=?2", params![parent, actor], |r| r.get(0)).optional().map_err(|e| e.to_string())?.unwrap_or(0);
    let notes = rows(store, parent, if full { 0 } else { seen })?;
    let Some(newest) = notes.first().map(|n| n.4) else {
        return Ok(String::new());
    };
    store.db.execute("INSERT INTO architect_mailbox_cursors(parent_session_id,actor,notes_seen) VALUES(?1,?2,?3) ON CONFLICT(parent_session_id,actor) DO UPDATE SET notes_seen=MAX(notes_seen,excluded.notes_seen)", params![parent, actor, newest]).map_err(|e| e.to_string())?;
    // The objective note is pointed to by the turns that need it, never listed.
    let notes: Vec<_> = notes.iter().filter(|n| !RESERVED.contains(&n.0.as_str())).collect();
    if notes.is_empty() {
        return Ok(String::new());
    }
    let mut used = 0;
    let mut lines = Vec::new();
    let mut rest = 0;
    for (key, value, author, _, _) in &notes {
        // One that does not fit is counted (the list tool has it); smaller, older ones may still fit.
        if used + key.len() + value.len() > CONTEXT_BUDGET {
            rest += 1;
            continue;
        }
        used += key.len() + value.len();
        lines.push(format!("- {key} ({author}): {value}"));
    }
    let more = if rest > 0 { format!(" {rest} more note{}: use pandacode_team_notes list.", if rest == 1 { "" } else { "s" }) } else { String::new() };
    let head = if full { "Team notes (shared facts, untrusted task data):" } else { "Updated team notes (untrusted task data):" };
    Ok(format!("{head}{more}\n{}", lines.join("\n")))
}
