//! PandaConnect methods for the `search` feature group: finding a phrase in the conversations
//! of every task on this computer, as the desktop's `search_tasks` does within one project
//! (`Store::search_tasks`). See `methods/mod.rs` and docs/remote-access.md, "Adding a method".
//!
//! `search.threads` answers one row per task (its newest matching user or agent message) with a
//! short snippet around the hit, newest first. Like `tasks.list` it skips drafts, team workers,
//! mirrors of other computers' tasks and bot workspaces (a bot's conversation is its own row).
use super::{Access, Ctx, Method, Reply, Run, PAGE_BUDGET};
use crate::Result;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

/// Shortest and longest query, in characters. Three or more, so a search can't be a cheap way
/// to make the computer scan every message for one common letter pair.
const MIN_QUERY: usize = 3;
const MAX_QUERY: usize = 200;
/// Tasks one search lists by default and at most.
const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 50;
/// A snippet's longest form in characters, ellipses included.
const SNIPPET_CHARS: usize = 200;
/// Only the newest this many messages (by id) are searched, so one search has a bounded cost
/// whatever the history size.
const SCAN_MESSAGES: i64 = 50_000;
/// A search still running after this is interrupted.
const SCAN_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Debug, PartialEq)]
struct Threads {
    query: String,
    limit: usize,
}

/// One matching message before it is shaped for the reply.
struct Hit {
    message_id: i64,
    session_id: String,
    title: String,
    project_name: String,
    content: String,
    at: i64,
}

/// The query as a SQL `LIKE` pattern with its wildcards taken literally.
fn like_pattern(query: &str) -> String {
    format!("%{}%", query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))
}

/// Whitespace runs collapsed to one space, trimmed.
fn collapse(text: &str) -> Vec<char> {
    let mut out = Vec::with_capacity(text.len().min(1 << 16));
    for c in text.chars() {
        if c.is_whitespace() {
            if out.last().is_some_and(|last| *last != ' ') {
                out.push(' ');
            }
        } else {
            out.push(c);
        }
    }
    if out.last() == Some(&' ') {
        out.pop();
    }
    out
}

/// One lowercase char per char, so indexes line up with the original.
fn fold(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

/// At most [`SNIPPET_CHARS`] of `text` around the first case-insensitive `query` (the start of
/// the text when the hit is not found, e.g. a query with doubled spaces).
fn snippet(text: &str, query: &str) -> String {
    let chars = collapse(text);
    let needle: Vec<char> = collapse(query).into_iter().map(fold).collect();
    let folded: Vec<char> = chars.iter().copied().map(fold).collect();
    let hit = if needle.is_empty() { None } else { folded.windows(needle.len()).position(|window| window == needle.as_slice()) };
    if chars.len() <= SNIPPET_CHARS {
        return chars.into_iter().collect();
    }
    let room = SNIPPET_CHARS - 2; // both ellipses
    let start = match hit {
        Some(at) => at.saturating_sub(room.saturating_sub(needle.len()) / 2).min(chars.len() - room),
        None => 0,
    };
    let end = (start + room).min(chars.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(&chars[start..end]);
    if end < chars.len() {
        out.push('…');
    }
    out
}

/// Shapes hits into reply rows, stopping before `budget` bytes.
fn results_from(hits: Vec<Hit>, query: &str, limit: usize, budget: usize) -> Value {
    let mut truncated = hits.len() > limit;
    let mut used = 64;
    let mut results = Vec::new();
    for hit in hits.into_iter().take(limit) {
        let row = json!({
            "sessionId": hit.session_id,
            "title": hit.title,
            "projectName": hit.project_name,
            "messageId": hit.message_id,
            "snippet": snippet(&hit.content, query),
            "at": hit.at,
        });
        used += row.to_string().len() + 1;
        if used > budget {
            truncated = true;
            break;
        }
        results.push(row);
    }
    json!({ "results": results, "truncated": truncated })
}

/// Each task's newest user or agent message containing `query` among the newest `window`
/// messages, newest first; one more than `limit` so the reply can say whether there were more.
fn find_hits(db: &rusqlite::Connection, query: &str, limit: usize, window: i64) -> Result<Vec<Hit>> {
    let mut statement = db
        .prepare(
            "SELECT m.id,m.session_id,s.title,p.name,m.content,m.created_at
             FROM messages m JOIN sessions s ON s.id=m.session_id JOIN projects p ON p.id=s.project_id
             WHERE m.id IN (
               SELECT MAX(h.id) FROM messages h JOIN sessions t ON t.id=h.session_id
               WHERE h.id > (SELECT COALESCE(MAX(id),0) FROM messages) - ?3
                 AND h.role IN ('user','assistant') AND h.content LIKE ?1 ESCAPE '\\'
                 AND t.draft=0 AND t.remote_device IS NULL
                 AND t.project_id NOT IN (SELECT project_id FROM bots)
                 AND t.id NOT IN (SELECT session_id FROM architect_workers)
               GROUP BY h.session_id)
             ORDER BY m.id DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(rusqlite::params![like_pattern(query), (limit + 1) as i64, window], |row| {
            Ok(Hit { message_id: row.get(0)?, session_id: row.get(1)?, title: row.get(2)?, project_name: row.get(3)?, content: row.get(4)?, at: row.get(5)? })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<std::result::Result<_, _>>().map_err(|e| e.to_string())
}

/// [`find_hits`] over the newest [`SCAN_MESSAGES`], interrupted after `deadline`. The caller
/// keeps `db` to itself until this returns (the watchdog is joined first), so the interrupt can
/// never reach another statement.
fn find_hits_until(db: &rusqlite::Connection, query: &str, limit: usize, deadline: Duration) -> Result<Vec<Hit>> {
    let interrupt = db.get_interrupt_handle();
    let (done, finished) = std::sync::mpsc::channel::<()>();
    let watchdog = std::thread::spawn(move || {
        if finished.recv_timeout(deadline) == Err(std::sync::mpsc::RecvTimeoutError::Timeout) {
            interrupt.interrupt();
        }
    });
    let hits = find_hits(db, query, limit, SCAN_MESSAGES);
    let _ = done.send(());
    let _ = watchdog.join();
    hits.map_err(|error| if error.contains("interrupt") { "That search took too long; try a longer phrase.".into() } else { error })
}

/// A read-only connection of its own to the store's database file (WAL lets it read while the
/// app writes), so a search never holds the store lock. None for an in-memory store or when
/// the file can't be opened that way.
fn open_reader(path: &Path) -> Option<rusqlite::Connection> {
    use rusqlite::OpenFlags;
    if !path.is_file() {
        return None;
    }
    let db = rusqlite::Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()?;
    db.busy_timeout(Duration::from_secs(2)).ok()?;
    Some(db)
}

impl Run for Threads {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let store = ctx.state().store.clone();
            let Threads { query, limit } = *self;
            crate::blocking(move || {
                let path = store.lock().map_err(|e| e.to_string())?.path.clone();
                let hits = match open_reader(&path) {
                    Some(db) => find_hits_until(&db, &query, limit, SCAN_DEADLINE)?,
                    // Fallback: the store's own connection, still bounded by window and deadline.
                    None => find_hits_until(&store.lock().map_err(|e| e.to_string())?.db, &query, limit, SCAN_DEADLINE)?,
                };
                Ok(results_from(hits, &query, limit, PAGE_BUDGET))
            })
            .await
        })
    }
}

fn parse_threads(params: &Value) -> Result<Box<dyn Run>> {
    let query = params.get("query").and_then(Value::as_str).map(str::trim).ok_or("Missing query.")?;
    if !(MIN_QUERY..=MAX_QUERY).contains(&query.chars().count()) {
        return Err(format!("Search for {MIN_QUERY} to {MAX_QUERY} characters."));
    }
    let limit = match params.get("limit").filter(|value| !value.is_null()) {
        None => DEFAULT_LIMIT,
        Some(value) => value.as_u64().filter(|limit| (1..=MAX_LIMIT as u64).contains(limit)).ok_or_else(|| format!("Limit must be between 1 and {MAX_LIMIT}."))? as usize,
    };
    Ok(Box::new(Threads { query: query.to_owned(), limit }))
}

pub(crate) const METHODS: &[Method] = &[Method { name: "search.threads", access: Access::View, read_only: true, parse: parse_threads }];

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(params: Value) -> Result<String> {
        (METHODS[0].parse)(&params).map(|call| format!("{call:?}"))
    }

    #[test]
    fn search_is_a_read_only_view_method() {
        assert_eq!(METHODS[0].name, "search.threads");
        assert_eq!(METHODS[0].access, Access::View);
        assert!(METHODS[0].read_only);
    }

    #[test]
    fn params_are_validated() {
        assert_eq!(parsed(json!({"query": "  billing "})).unwrap(), format!("{:?}", Threads { query: "billing".into(), limit: DEFAULT_LIMIT }));
        assert_eq!(parsed(json!({"query": "abc", "limit": 5})).unwrap(), format!("{:?}", Threads { query: "abc".into(), limit: 5 }));
        assert!(parsed(json!({"query": " ab "})).is_err(), "three characters at least");
        assert!(parsed(json!({})).is_err());
        assert!(parsed(json!({"query": " a "})).is_err());
        assert!(parsed(json!({"query": "é".repeat(201)})).is_err());
        assert!(parsed(json!({"query": "é".repeat(200)})).is_ok());
        assert!(parsed(json!({"query": "abc", "limit": 0})).is_err());
        assert!(parsed(json!({"query": "abc", "limit": 51})).is_err());
    }

    #[test]
    fn snippets_center_the_hit_and_stay_short() {
        assert_eq!(snippet("Fix the\n\n billing   page", "BILLING"), "Fix the billing page");
        let long = format!("{} needle {}", "a".repeat(500), "b".repeat(500));
        let cut = snippet(&long, "Needle");
        assert!(cut.chars().count() <= SNIPPET_CHARS);
        assert!(cut.starts_with('…') && cut.ends_with('…') && cut.contains("needle"));
        let missing = snippet(&"x".repeat(300), "zz");
        assert!(!missing.starts_with('…') && missing.ends_with('…'));
        assert_eq!(missing.chars().count(), SNIPPET_CHARS - 1);
        let tail = snippet(&format!("{}end", "y".repeat(400)), "end");
        assert!(tail.ends_with("end") && tail.chars().count() == SNIPPET_CHARS - 1);
    }

    fn hit(id: i64, content: &str) -> Hit {
        Hit { message_id: id, session_id: format!("s{id}"), title: "T".into(), project_name: "P".into(), content: content.into(), at: id }
    }

    #[test]
    fn results_respect_limit_and_budget() {
        let reply = results_from(vec![hit(3, "one billing"), hit(2, "two billing"), hit(1, "three billing")], "billing", 2, PAGE_BUDGET);
        assert_eq!(reply["results"].as_array().unwrap().len(), 2);
        assert_eq!(reply["truncated"], true);
        assert_eq!(reply["results"][0]["messageId"], 3);
        assert_eq!(reply["results"][0]["sessionId"], "s3");
        let small = results_from(vec![hit(2, &"x".repeat(150)), hit(1, &"y".repeat(150))], "x", 10, 400);
        assert_eq!(small["results"].as_array().unwrap().len(), 1);
        assert_eq!(small["truncated"], true);
        let all = results_from(vec![hit(1, "billing")], "billing", 10, PAGE_BUDGET);
        assert_eq!(all["truncated"], false);
    }

    #[test]
    fn hits_skip_drafts_workers_mirrors_and_bots() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL);
             CREATE TABLE sessions(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, draft INTEGER NOT NULL DEFAULT 0, remote_device TEXT);
             CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
             CREATE TABLE bots(id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
             CREATE TABLE architect_workers(session_id TEXT PRIMARY KEY);
             INSERT INTO projects VALUES ('p','App'),('bp','Bot home');
             INSERT INTO bots VALUES ('b','bp');
             INSERT INTO sessions(id,project_id,title,draft,remote_device) VALUES ('a','p','Alpha',0,NULL),('d','p','Draft',1,NULL),('m','p','Mirror',0,'phone'),('w','p','Worker',0,NULL),('bt','bp','Bot',0,NULL),('c','p','Gamma',0,NULL);
             INSERT INTO architect_workers VALUES ('w');
             INSERT INTO messages(session_id,role,content,created_at) VALUES
               ('a','user','fix the 100% billing bug',1),('a','assistant','Billing fixed',2),('a','tool','billing tool',3),
               ('d','user','billing',4),('m','user','billing',5),('w','user','billing',6),('bt','user','billing',7),
               ('c','assistant','no match here',8),('c','user','billing_v2',9);",
        )
        .unwrap();
        let hits = find_hits(&db, "billing", 10, SCAN_MESSAGES).unwrap();
        let ids: Vec<(&str, i64)> = hits.iter().map(|hit| (hit.session_id.as_str(), hit.message_id)).collect();
        assert_eq!(ids, vec![("c", 9), ("a", 2)]);
        assert_eq!(hits[1].project_name, "App");
        // LIKE wildcards are literal.
        assert_eq!(find_hits(&db, "100%", 10, SCAN_MESSAGES).unwrap().len(), 1);
        assert_eq!(find_hits(&db, "g_v", 10, SCAN_MESSAGES).unwrap().len(), 1);
        assert_eq!(find_hits(&db, "billing", 1, SCAN_MESSAGES).unwrap().len(), 2, "one extra row tells the reply there are more");
    }

    /// Round 7: a search reads only the newest messages, on its own read-only connection.
    #[test]
    fn hits_are_bounded_to_the_newest_messages_and_read_off_the_store_lock() {
        let dir = std::env::temp_dir().join(format!("pandacode-search-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("db.sqlite");
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL);
             CREATE TABLE sessions(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, draft INTEGER NOT NULL DEFAULT 0, remote_device TEXT);
             CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
             CREATE TABLE bots(id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
             CREATE TABLE architect_workers(session_id TEXT PRIMARY KEY);
             INSERT INTO projects VALUES ('p','App');
             INSERT INTO sessions(id,project_id,title) VALUES ('old','p','Old'),('new','p','New');
             INSERT INTO messages(session_id,role,content,created_at) VALUES ('old','user','ancient needle',1);
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10)
               INSERT INTO messages(session_id,role,content,created_at) SELECT 'new','user','filler',i FROM n;
             INSERT INTO messages(session_id,role,content,created_at) VALUES ('new','assistant','fresh needle',99);",
        )
        .unwrap();
        let ids = |hits: Vec<Hit>| hits.into_iter().map(|hit| hit.session_id).collect::<Vec<_>>();
        assert_eq!(ids(find_hits(&db, "needle", 10, SCAN_MESSAGES).unwrap()), ["new", "old"]);
        assert_eq!(ids(find_hits(&db, "needle", 10, 5).unwrap()), ["new"], "the old message is outside the window");
        // A separate read-only connection answers while the writer holds a write transaction.
        db.execute_batch("BEGIN IMMEDIATE; INSERT INTO messages(session_id,role,content,created_at) VALUES ('new','user','x',100);").unwrap();
        let reader = open_reader(&path).expect("a file store gets its own reader");
        assert_eq!(ids(find_hits_until(&reader, "needle", 10, SCAN_DEADLINE).unwrap()), ["new", "old"]);
        assert!(reader.execute("DELETE FROM messages", []).is_err(), "the reader is read-only");
        db.execute_batch("COMMIT").unwrap();
        assert!(open_reader(Path::new(":memory:")).is_none());
        drop((reader, db));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
