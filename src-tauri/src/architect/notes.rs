//! A shared blackboard per team: durable facts (API shapes, decisions) any
//! member can set and every member reads, plus the side tables mailboxes need.
//! Tables are created on first use, so the app storage schema is unchanged.
use super::*;

const KEY_LIMIT: usize = 256;
/// Keys and full values of notes changed since the last turn.
const CONTEXT_BUDGET: usize = 3 * 1024;
/// Bytes of full-value note lines in a launch brief, newest first: a single-turn worker
/// needs the values now, and a `get` round trip re-reads the whole cached prefix.
const LAUNCH_BUDGET: usize = 3 * 1024;
/// Bytes of `key (author): preview` lines for the notes after those (full text through `get`).
const PREVIEW_BUDGET: usize = 1024;

/// Defines `TABLES` and `PRESENT_SQL` (how many of them exist) from one list of names.
macro_rules! side_tables {
    ($first:literal $(, $rest:literal)* $(,)?) => {
        const TABLES: &[&str] = &[$first $(, $rest)*];
        const PRESENT_SQL: &str = concat!("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('", $first, "'", $(",'", $rest, "'",)* ")");
    };
}
// The side tables `ensure` creates: keep this list in step with its DDL.
side_tables!(
    "architect_notes",
    "architect_mailbox_cursors",
    "architect_message_replies",
    "architect_brief_marks",
    "architect_note_previews",
    "architect_note_revisions",
);

/// The side tables, created on first use. Every team tool result asks, so once all of `TABLES`
/// exist one cached lookup of the schema answers instead of running the DDL again.
pub(in crate::architect) fn ensure(store: &Store) -> Result<()> {
    let present: i64 = store.db.prepare_cached(PRESENT_SQL)
        .and_then(|mut query| query.query_row([], |r| r.get(0)))
        .map_err(|e| e.to_string())?;
    if present == TABLES.len() as i64 {
        return Ok(());
    }
    store.db.execute_batch("CREATE TABLE IF NOT EXISTS architect_notes(parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,key TEXT NOT NULL,value TEXT NOT NULL,author TEXT NOT NULL,updated_at INTEGER NOT NULL,rev INTEGER NOT NULL,PRIMARY KEY(parent_session_id,key));
        CREATE TABLE IF NOT EXISTS architect_mailbox_cursors(parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,actor TEXT NOT NULL,message_id INTEGER NOT NULL DEFAULT 0,notes_seen INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(parent_session_id,actor));
        CREATE TABLE IF NOT EXISTS architect_message_replies(message_id INTEGER PRIMARY KEY REFERENCES architect_messages(id) ON DELETE CASCADE,reply_to INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS architect_brief_marks(parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,session_id TEXT NOT NULL,message_id INTEGER NOT NULL,PRIMARY KEY(parent_session_id,session_id));
        CREATE TABLE IF NOT EXISTS architect_note_previews(parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,actor TEXT NOT NULL,key TEXT NOT NULL,rev INTEGER NOT NULL,PRIMARY KEY(parent_session_id,actor,key));
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
    let rev: i64 = store.db.prepare_cached("SELECT 1+MAX(COALESCE((SELECT rev FROM architect_note_revisions WHERE parent_session_id=?1),0),COALESCE((SELECT MAX(rev) FROM architect_notes WHERE parent_session_id=?1),0),COALESCE((SELECT MAX(notes_seen) FROM architect_mailbox_cursors WHERE parent_session_id=?1),0))")
        .and_then(|mut query| query.query_row([parent], |r| r.get(0)))
        .map_err(|e| e.to_string())?;
    store.db.prepare_cached("INSERT INTO architect_note_revisions(parent_session_id,rev) VALUES(?1,?2) ON CONFLICT(parent_session_id) DO UPDATE SET rev=excluded.rev")
        .and_then(|mut query| query.execute(params![parent, rev]))
        .map_err(|e| e.to_string())?;
    Ok(rev)
}
fn write(store: &Store, parent: &str, key: &str, value: &str, author: &str) -> Result<()> {
    let rev = next_rev(store, parent)?;
    store.db.prepare_cached("INSERT INTO architect_notes(parent_session_id,key,value,author,updated_at,rev) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(parent_session_id,key) DO UPDATE SET value=excluded.value,author=excluded.author,updated_at=excluded.updated_at,rev=excluded.rev")
        .and_then(|mut query| query.execute(params![parent, key, value, author, storage::now(), rev]))
        .map(|_| ())
        .map_err(|e| e.to_string())
}
/// Whether PandaCode itself wrote this reserved note: an agent's note under the key (from before it
/// was reserved) is not the text turns point at.
pub(in crate::architect) fn exists(store: &Store, parent: &str, key: &str) -> Result<bool> {
    store.db.prepare_cached("SELECT EXISTS(SELECT 1 FROM architect_notes WHERE parent_session_id=?1 AND key=?2 AND author=?3)")
        .and_then(|mut query| query.query_row(params![parent, key, APP], |r| r.get(0)))
        .map_err(|e| e.to_string())
}
/// Writes a reserved note, or deletes PandaCode's own with `None`; an agent's note is left alone.
pub(in crate::architect) fn set_reserved(store: &Store, parent: &str, key: &str, value: Option<&str>) -> Result<()> {
    match value {
        Some(value) => write(store, parent, key, value, APP),
        None => store.db.execute("DELETE FROM architect_notes WHERE parent_session_id=?1 AND key=?2 AND author=?3", params![parent, key, APP]).map(|_| ()).map_err(|e| e.to_string()),
    }
}

pub(in crate::architect) fn tool(store: &Store, parent: &str, author: &str, args: Value) -> Result<Value> {
    let args: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
    if args.action == "list" {
        return list(store, parent, args.cursor.as_deref());
    }
    let key = args.key.filter(|k| valid_key(k)).ok_or("Use a note key of up to 256 characters from a-z, A-Z, 0-9, '.', '_' and '-'.")?;
    match args.action.as_str() {
        "get" => {
            // The full text is seen now: a preview it stood behind no longer needs delivering.
            store.db.prepare_cached("DELETE FROM architect_note_previews WHERE parent_session_id=?1 AND actor=?2 AND key=?3")
                .and_then(|mut query| query.execute(params![parent, author, key]))
                .map_err(|e| e.to_string())?;
            super::note_fetched(parent, author, &key);
            let note = store.db.prepare_cached("SELECT value,author,updated_at FROM architect_notes WHERE parent_session_id=?1 AND key=?2")
                .and_then(|mut query| query.query_row(params![parent, key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))).optional())
                .map_err(|e| e.to_string())?;
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
    let mut query = store.db.prepare_cached("SELECT key,value,author,updated_at,rev FROM architect_notes WHERE parent_session_id=?1 AND rev>?2 ORDER BY rev DESC").map_err(|e| e.to_string())?;
    let rows = query.query_map(params![parent, after], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).map_err(|e| e.to_string())?;
    rows.collect::<std::result::Result<_, _>>().map_err(|e| e.to_string())
}
/// One page of previews in key order, up to `PAGE_BYTES` serialized (at least one note). The cursor is
/// the last key, so updating a note mid-listing never moves it past the cursor; briefs announce changes.
fn list(store: &Store, parent: &str, cursor: Option<&str>) -> Result<Value> {
    let mut query = store.db.prepare_cached("SELECT key,substr(value,1,161),author,updated_at FROM architect_notes WHERE parent_session_id=?1 AND key>?2 ORDER BY key").map_err(|e| e.to_string())?;
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

pub(in crate::architect) fn preview(text: &str) -> String {
    match text.char_indices().nth(160) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.into(),
    }
}

/// Notes the actor saw only as launch-brief previews and has not fetched, still unchanged:
/// the next incremental brief delivers their full values.
fn previewed(store: &Store, parent: &str, actor: &str) -> Result<Vec<Note>> {
    let mut query = store.db.prepare_cached("SELECT n.key,n.value,n.author,n.updated_at,n.rev FROM architect_note_previews p JOIN architect_notes n ON n.parent_session_id=p.parent_session_id AND n.key=p.key AND n.rev=p.rev WHERE p.parent_session_id=?1 AND p.actor=?2 ORDER BY n.rev DESC").map_err(|e| e.to_string())?;
    let rows = query.query_map(params![parent, actor], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).map_err(|e| e.to_string())?;
    rows.collect::<std::result::Result<_, _>>().map_err(|e| e.to_string())
}

/// Pending preview update staged while building a brief, committed only once the run accepts it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum PreviewTransition {
    /// Launch brief (`full == true`): replaces the actor's pending previews with `(key, rev)`.
    Replace(Vec<(String, i64)>),
    /// Incremental brief (`full == false`): clears `(key, rev)` previews delivered in full.
    Clear(Vec<(String, i64)>),
}

/// Staged note-delivery state (`notes_seen` cursor and preview transitions) for an in-flight brief.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Staged {
    pub actor: String,
    pub newest: i64,
    pub previews: PreviewTransition,
}

/// Replaces the actor's pending previews with `notes` (key, rev).
fn set_previewed(store: &Store, parent: &str, actor: &str, notes: &[(String, i64)]) -> Result<()> {
    store.db.prepare_cached("DELETE FROM architect_note_previews WHERE parent_session_id=?1 AND actor=?2")
        .and_then(|mut query| query.execute(params![parent, actor]))
        .map_err(|e| e.to_string())?;
    let mut insert = store.db.prepare_cached("INSERT INTO architect_note_previews(parent_session_id,actor,key,rev) VALUES(?1,?2,?3,?4)").map_err(|e| e.to_string())?;
    for (key, rev) in notes {
        insert.execute(params![parent, actor, key, rev]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Clears previews that were delivered in full in an incremental brief.
fn clear_previewed(store: &Store, parent: &str, actor: &str, notes: &[(String, i64)]) -> Result<()> {
    let mut delete = store.db.prepare_cached("DELETE FROM architect_note_previews WHERE parent_session_id=?1 AND actor=?2 AND key=?3 AND rev=?4").map_err(|e| e.to_string())?;
    for (key, rev) in notes {
        delete.execute(params![parent, actor, key, rev]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn mark_seen(store: &Store, parent: &str, actor: &str, newest: i64) -> Result<()> {
    store.db.prepare_cached("INSERT INTO architect_mailbox_cursors(parent_session_id,actor,notes_seen) VALUES(?1,?2,?3) ON CONFLICT(parent_session_id,actor) DO UPDATE SET notes_seen=MAX(notes_seen,excluded.notes_seen)")
        .and_then(|mut query| query.execute(params![parent, actor, newest]))
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Commits the `notes_seen` cursor and preview transitions after a brief's run ends cleanly.
pub(super) fn commit(store: &Store, parent: &str, staged: Staged) -> Result<()> {
    mark_seen(store, parent, &staged.actor, staged.newest)?;
    match staged.previews {
        PreviewTransition::Replace(previews) => set_previewed(store, parent, &staged.actor, &previews),
        PreviewTransition::Clear(delivered) => clear_previewed(store, parent, &staged.actor, &delivered),
    }
}

/// Notes for a prompt, side-effect free: returns the formatted block and any `Staged` transition
/// to commit once the brief is accepted. With `full` (a fresh or compacted context) every note
/// newest first: full values within `LAUNCH_BUDGET`, then previews within `PREVIEW_BUDGET`, which
/// stay pending until fetched with `get` or delivered by the next incremental brief; the rest are
/// counted. Otherwise only notes changed since the actor last saw notes (and pending previews),
/// with their values.
pub(super) fn context(store: &Store, parent: &str, actor: &str, full: bool) -> Result<(String, Option<Staged>)> {
    let seen: i64 = store.db.prepare_cached("SELECT notes_seen FROM architect_mailbox_cursors WHERE parent_session_id=?1 AND actor=?2")
        .and_then(|mut query| query.query_row(params![parent, actor], |r| r.get(0)).optional())
        .map_err(|e| e.to_string())?
        .unwrap_or(0);
    let mut notes = rows(store, parent, if full { 0 } else { seen })?;
    let mut pending = Vec::new();
    if !full {
        let changed: std::collections::HashSet<String> = notes.iter().map(|n| n.0.clone()).collect();
        let previews = previewed(store, parent, actor)?;
        pending = previews.iter().map(|n| (n.0.clone(), n.4)).collect();
        notes.extend(previews.into_iter().filter(|n| !changed.contains(&n.0)));
        notes.sort_by_key(|note| std::cmp::Reverse(note.4));
    }
    let Some(newest) = notes.iter().map(|n| n.4).max() else {
        return Ok((String::new(), None));
    };
    // The objective note is pointed to by the turns that need it, never listed.
    notes.retain(|n| !RESERVED.contains(&n.0.as_str()));
    if notes.is_empty() {
        let previews = if full { PreviewTransition::Replace(Vec::new()) } else { PreviewTransition::Clear(Vec::new()) };
        return Ok((String::new(), Some(Staged { actor: actor.to_owned(), newest, previews })));
    }
    let (text, previews) = if full { launch(&notes) } else { changed(&notes, &pending) };
    Ok((text, Some(Staged { actor: actor.to_owned(), newest, previews })))
}

/// A launch brief's notes: full values while they fit, newest first, then previews while
/// they fit. Only the notes shown as previews are pending delivery.
fn launch(notes: &[Note]) -> (String, PreviewTransition) {
    let mut lines = Vec::new();
    let mut used = 0;
    let mut rest = Vec::new();
    for note in notes {
        let (key, value, author, ..) = note;
        let line = format!("- {key} ({author}): {value}");
        // One that does not fit gets a preview below; smaller, older ones may still fit.
        if used + line.len() + 1 > LAUNCH_BUDGET {
            rest.push(note);
            continue;
        }
        used += line.len() + 1;
        lines.push(line);
    }
    let mut previews = Vec::new();
    used = 0;
    for (key, value, author, _, rev) in &rest {
        let line = format!("- {key} ({author}): {}", preview(value));
        if used + line.len() + 1 > PREVIEW_BUDGET {
            break;
        }
        used += line.len() + 1;
        previews.push((key.clone(), *rev));
        lines.push(line);
    }
    let left = notes.len() - lines.len();
    let cut = if previews.is_empty() { String::new() } else { format!("; {} cut to previews, full text through pandacode_team_notes get", previews.len()) };
    let more = if left > 0 { format!(" {left} more notes: use pandacode_team_notes list.") } else { String::new() };
    let head = format!("Team notes (shared facts, untrusted task data, {} in all{cut}):{more}", notes.len());
    let text = if lines.is_empty() { head } else { format!("{head}\n{}", lines.join("\n")) };
    (text, PreviewTransition::Replace(previews))
}

/// An incremental brief's notes: changed ones with their values within `CONTEXT_BUDGET`.
/// `pending` (key, rev) are the previews still owed in full: those past the budget stay
/// pending for the next brief; delivered ones are marked to clear on brief acceptance.
fn changed(notes: &[Note], pending: &[(String, i64)]) -> (String, PreviewTransition) {
    let mut used = 0;
    let mut lines = Vec::new();
    let mut left = Vec::new();
    for note in notes {
        let (key, value, author, ..) = note;
        let line = format!("- {key} ({author}): {value}");
        // One that does not fit is counted (the list tool has it); smaller ones may still fit.
        if used + line.len() + 1 > CONTEXT_BUDGET {
            left.push(note);
            continue;
        }
        used += line.len() + 1;
        lines.push(line);
    }
    let delivered: Vec<(String, i64)> = pending
        .iter()
        .filter(|(k, rev)| !left.iter().any(|n| n.0 == *k && n.4 == *rev))
        .cloned()
        .collect();
    // The cursor passes these too, so the count is how they stay findable.
    let more = if left.is_empty() { String::new() } else { format!(" {} more changed note{}: use pandacode_team_notes list.", left.len(), if left.len() == 1 { "" } else { "s" }) };
    let head = format!("Updated team notes (untrusted task data):{more}");
    let text = if lines.is_empty() { head } else { format!("{head}\n{}", lines.join("\n")) };
    (text, PreviewTransition::Clear(delivered))
}

/// Bytes of keys in the periodic refresh's notes index.
const INDEX_BUDGET: usize = 240;

/// Every note's key, newest first within `INDEX_BUDGET`, for the periodic refresh: values
/// went out when they changed, so this only reminds a silently compacted context they exist.
/// Leaves the seen cursor alone.
pub(super) fn index(store: &Store, parent: &str) -> Result<String> {
    let mut notes = rows(store, parent, 0)?;
    notes.retain(|n| !RESERVED.contains(&n.0.as_str()));
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

#[cfg(test)]
#[path = "notes_tests.rs"]
mod notes_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_creates_every_side_table_once_and_one_count_sees_them() {
        let path = std::env::temp_dir().join(format!("pandacode-notes-ensure-{}.db", storage::id()));
        {
            let store = Store::open(&path).unwrap();
            store.db.execute_batch(&TABLES.iter().map(|table| format!("DROP TABLE IF EXISTS {table};")).collect::<String>()).unwrap();
            let count = |store: &Store| store.db.query_row(PRESENT_SQL, [], |r| r.get::<_, i64>(0)).unwrap();
            assert_eq!(count(&store), 0);
            ensure(&store).unwrap();
            assert_eq!(count(&store), TABLES.len() as i64);
            store.db.execute_batch("DROP TABLE architect_note_revisions").unwrap();
            ensure(&store).unwrap();
            assert_eq!(count(&store), TABLES.len() as i64, "a missing table is recreated");
        }
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }
}
