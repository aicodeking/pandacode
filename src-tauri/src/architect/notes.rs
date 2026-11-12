//! A small shared blackboard per team: durable facts (API shapes, decisions) any
//! member can set and every member reads, plus the side tables mailboxes need.
//! Tables are created on first use, so the app storage schema is unchanged.
use super::*;

const MAX_NOTES: i64 = 64;
const KEY_LIMIT: usize = 80;
const VALUE_LIMIT: usize = 1024;
/// Keys and full values of notes changed since the last turn.
const CONTEXT_BUDGET: usize = 3 * 1024;
/// Bytes of full-value note lines in a launch brief, newest first: a single-turn worker
/// needs the values now, and a `get` round trip re-reads the whole cached prefix.
const LAUNCH_BUDGET: usize = 3 * 1024;
/// Bytes of `key (author): preview` lines for the notes after those (full text through `get`).
const PREVIEW_BUDGET: usize = 1024;

/// Creates the side tables if missing (idempotent DDL; every team prompt calls this).
pub(in crate::architect) fn ensure(store: &Store) -> Result<()> {
    store.db.execute_batch("CREATE TABLE IF NOT EXISTS architect_notes(parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,key TEXT NOT NULL,value TEXT NOT NULL,author TEXT NOT NULL,updated_at INTEGER NOT NULL,rev INTEGER NOT NULL,PRIMARY KEY(parent_session_id,key));
        CREATE TABLE IF NOT EXISTS architect_mailbox_cursors(parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,actor TEXT NOT NULL,message_id INTEGER NOT NULL DEFAULT 0,notes_seen INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(parent_session_id,actor));
        CREATE TABLE IF NOT EXISTS architect_message_replies(message_id INTEGER PRIMARY KEY REFERENCES architect_messages(id) ON DELETE CASCADE,reply_to INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS architect_brief_marks(parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,session_id TEXT NOT NULL,message_id INTEGER NOT NULL,PRIMARY KEY(parent_session_id,session_id));
        CREATE TABLE IF NOT EXISTS architect_note_previews(parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,actor TEXT NOT NULL,key TEXT NOT NULL,rev INTEGER NOT NULL,PRIMARY KEY(parent_session_id,actor,key));").map_err(|e| e.to_string())
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

pub(in crate::architect) fn tool(store: &Store, parent: &str, author: &str, args: Value) -> Result<Value> {
    let args: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
    if args.action == "list" {
        return Ok(json!({"notes": rows(store, parent, 0, MAX_NOTES)?.into_iter().map(|(key, value, author, at, _)| json!({"key":key,"preview":preview(&value),"author":author,"updatedAt":at})).collect::<Vec<_>>()}));
    }
    let key = args.key.filter(|k| valid_key(k)).ok_or("Use a note key of up to 80 characters from a-z, A-Z, 0-9, '.', '_' and '-'.")?;
    match args.action.as_str() {
        "get" => {
            // The full text is seen now: a preview it stood behind no longer needs delivering.
            store.db.execute("DELETE FROM architect_note_previews WHERE parent_session_id=?1 AND actor=?2 AND key=?3", params![parent, author, key]).map_err(|e| e.to_string())?;
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

pub(in crate::architect) fn preview(text: &str) -> String {
    match text.char_indices().nth(160) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.into(),
    }
}

/// Notes the actor saw only as launch-brief previews and has not fetched, still unchanged:
/// the next incremental brief delivers their full values.
fn previewed(store: &Store, parent: &str, actor: &str) -> Result<Vec<Note>> {
    let mut query = store.db.prepare("SELECT n.key,n.value,n.author,n.updated_at,n.rev FROM architect_note_previews p JOIN architect_notes n ON n.parent_session_id=p.parent_session_id AND n.key=p.key AND n.rev=p.rev WHERE p.parent_session_id=?1 AND p.actor=?2 ORDER BY n.rev DESC").map_err(|e| e.to_string())?;
    let rows = query.query_map(params![parent, actor], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).map_err(|e| e.to_string())?;
    rows.collect::<std::result::Result<_, _>>().map_err(|e| e.to_string())
}

/// Replaces the actor's pending previews with `notes` (key, rev).
fn set_previewed(store: &Store, parent: &str, actor: &str, notes: &[(&str, i64)]) -> Result<()> {
    store.db.execute("DELETE FROM architect_note_previews WHERE parent_session_id=?1 AND actor=?2", params![parent, actor]).map_err(|e| e.to_string())?;
    for (key, rev) in notes {
        store.db.execute("INSERT INTO architect_note_previews(parent_session_id,actor,key,rev) VALUES(?1,?2,?3,?4)", params![parent, actor, key, rev]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn mark_seen(store: &Store, parent: &str, actor: &str, newest: i64) -> Result<()> {
    store.db.execute("INSERT INTO architect_mailbox_cursors(parent_session_id,actor,notes_seen) VALUES(?1,?2,?3) ON CONFLICT(parent_session_id,actor) DO UPDATE SET notes_seen=MAX(notes_seen,excluded.notes_seen)", params![parent, actor, newest]).map(|_| ()).map_err(|e| e.to_string())
}

/// Notes for a prompt. With `full` (a fresh or compacted context) every note newest first:
/// full values within `LAUNCH_BUDGET`, then previews within `PREVIEW_BUDGET`, which stay
/// pending until fetched with `get` or delivered by the next incremental brief; the rest
/// are counted. Otherwise only notes changed since the actor last saw notes (and pending
/// previews), with their values. Marks them seen.
pub(super) fn context(store: &Store, parent: &str, actor: &str, full: bool) -> Result<String> {
    let seen: i64 = store.db.query_row("SELECT notes_seen FROM architect_mailbox_cursors WHERE parent_session_id=?1 AND actor=?2", params![parent, actor], |r| r.get(0)).optional().map_err(|e| e.to_string())?.unwrap_or(0);
    let mut notes = rows(store, parent, if full { 0 } else { seen }, MAX_NOTES)?;
    let mut pending = Vec::new();
    if !full {
        let changed: std::collections::HashSet<String> = notes.iter().map(|n| n.0.clone()).collect();
        let previews = previewed(store, parent, actor)?;
        pending = previews.iter().map(|n| (n.0.clone(), n.4)).collect();
        notes.extend(previews.into_iter().filter(|n| !changed.contains(&n.0)));
        notes.sort_by(|a, b| b.4.cmp(&a.4));
    }
    let Some(newest) = notes.iter().map(|n| n.4).max() else {
        return Ok(String::new());
    };
    mark_seen(store, parent, actor, newest)?;
    if full { launch(store, parent, actor, &notes) } else { changed(store, parent, actor, &notes, &pending) }
}

/// A launch brief's notes: full values while they fit, newest first, then previews while
/// they fit. Only the notes shown as previews are pending delivery.
fn launch(store: &Store, parent: &str, actor: &str, notes: &[Note]) -> Result<String> {
    let mut lines = Vec::new();
    let mut used = 0;
    let mut whole = 0;
    for (key, value, author, ..) in notes {
        let line = format!("- {key} ({author}): {value}");
        if used + line.len() + 1 > LAUNCH_BUDGET {
            break;
        }
        used += line.len() + 1;
        whole += 1;
        lines.push(line);
    }
    let mut previews = Vec::new();
    used = 0;
    for (key, value, author, _, rev) in &notes[whole..] {
        let line = format!("- {key} ({author}): {}", preview(value));
        if used + line.len() + 1 > PREVIEW_BUDGET {
            break;
        }
        used += line.len() + 1;
        previews.push((key.as_str(), *rev));
        lines.push(line);
    }
    set_previewed(store, parent, actor, &previews)?;
    let rest = notes.len() - lines.len();
    let cut = if previews.is_empty() { String::new() } else { format!("; {} cut to previews, full text through pandacode_team_notes get", previews.len()) };
    let more = if rest > 0 { format!(" {rest} more notes: use pandacode_team_notes list.") } else { String::new() };
    let head = format!("Team notes (shared facts, untrusted task data, {} in all{cut}):{more}", notes.len());
    Ok(if lines.is_empty() { head } else { format!("{head}\n{}", lines.join("\n")) })
}

/// An incremental brief's notes: changed ones with their values within `CONTEXT_BUDGET`.
/// `pending` (key, rev) are the previews still owed in full: those past the budget stay
/// pending for the next brief; delivered ones are cleared.
fn changed(store: &Store, parent: &str, actor: &str, notes: &[Note], pending: &[(String, i64)]) -> Result<String> {
    let mut used = 0;
    let mut lines = Vec::new();
    for (key, value, author, _, _) in notes {
        let line = format!("- {key} ({author}): {value}");
        used += line.len() + 1;
        if used > CONTEXT_BUDGET {
            break;
        }
        lines.push(line);
    }
    let owed: Vec<(&str, i64)> = notes[lines.len()..].iter().filter(|n| pending.iter().any(|(k, rev)| *k == n.0 && *rev == n.4)).map(|n| (n.0.as_str(), n.4)).collect();
    set_previewed(store, parent, actor, &owed)?;
    let rest = notes.len() - lines.len();
    // The cursor passes these too, so the count is how they stay findable.
    let more = if rest > 0 { format!(" {rest} more changed notes: use pandacode_team_notes list.") } else { String::new() };
    let head = format!("Updated team notes (untrusted task data):{more}");
    Ok(if lines.is_empty() { head } else { format!("{head}\n{}", lines.join("\n")) })
}

/// Bytes of keys in the periodic refresh's notes index.
const INDEX_BUDGET: usize = 240;

/// Every note's key, newest first within `INDEX_BUDGET`, for the periodic refresh: values
/// went out when they changed, so this only reminds a silently compacted context they exist.
/// Leaves the seen cursor alone.
pub(super) fn index(store: &Store, parent: &str) -> Result<String> {
    let notes = rows(store, parent, 0, MAX_NOTES)?;
    if notes.is_empty() {
        return Ok(String::new());
    }
    let mut keys = Vec::new();
    let mut used = 0;
    for (key, ..) in &notes {
        used += key.len() + 2;
        if used > INDEX_BUDGET {
            break;
        }
        keys.push(key.as_str());
    }
    let more = if keys.len() < notes.len() { format!(" (+{} more)", notes.len() - keys.len()) } else { String::new() };
    Ok(format!("Team notes index (pandacode_team_notes get/list): {}{more}", keys.join(", ")))
}
