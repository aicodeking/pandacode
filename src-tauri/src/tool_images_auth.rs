//! Whether a session's own tool records name an image path in an image-bearing
//! place, which is what lets `tool_images::load` serve that file.
//!
//! Inputs count when the path sits under an image field (`file_path`, `image`, …)
//! or is the whole input. Outputs count only when they are shaped like an image
//! path report: a line or JSON image field that is exactly the path, `Saved to
//! <path>`, `Screenshot saved: <path>`, or (image tools and file readers only)
//! `View image <path>` or `<image path=…>`.
//! A completed shell record also counts when its command names the path as the
//! output of an image-producing program (`shell`, e.g. `screencapture <path>`).
//! Only a `completed` record whose output is not a denial, block or interrupt
//! marker (`REFUSAL_MARKERS`) counts at all.
//! Free text never authorizes, so a page an agent read cannot name a local file,
//! and text snapshots of a page (`browser_snapshot`, accessibility trees) never
//! authorize from their output at all.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::storage::Store;

mod shell;
mod tool_names;

/// Tool records containing the file name fetched per store lock, newest first.
const CANDIDATE_BATCH: usize = 64;
/// Most candidate records parsed per lookup, so an image-heavy thread still finds
/// older images without an unbounded scan.
const CANDIDATE_SCAN_LIMIT: usize = 2_000;
/// Tool record inputs are sometimes JSON text holding JSON; nesting deeper than
/// this is not unwrapped.
const NESTED_JSON_DEPTH: usize = 4;
/// (session, path) pairs already found in a session's records.
const VIEWED_CACHE_SIZE: usize = 512;
/// How long a positive answer is trusted. Tool records can be deleted (thread
/// delete, retention), so a deleted record stops granting access after this.
const VIEWED_TTL: Duration = Duration::from_secs(10 * 60);
/// How long a miss is trusted while the session gains no new messages.
const MISSED_TTL: Duration = Duration::from_secs(30);
/// Fields that name an image file (at any depth of the input, or of an image
/// tool's JSON output).
const IMAGE_FIELDS: [&str; 7] = ["path", "file_path", "filePath", "image_path", "image", "screenshot", "savedPath"];
/// Tool-name fragments (lowercase) of tools whose output is page text (an
/// accessibility tree, a DOM snapshot); their output never authorizes.
const TEXT_SNAPSHOT_WORDS: [&str; 5] = ["browser_snapshot", "accessibility", "take_snapshot", "aria_snapshot", "ariasnapshot"];
/// Line starts (ASCII, any case) of an image tool's output after which the saved
/// image's path follows.
const CAPTURE_PREFIXES: [&str; 8] = [
    "saved to ",
    "saved as ",
    "saved screenshot to ",
    "screenshot saved: ",
    "screenshot saved to ",
    "screenshot saved as ",
    "screenshot saved at ",
    "wrote screenshot to ",
];
/// Playwright's `Took the viewport screenshot and saved it as <path>`.
const TOOK_PREFIX: &str = "took the ";
const TOOK_SAVED: &str = "screenshot and saved it as ";
/// Output starts that announce a viewed image, from an image tool or a file reader.
const VIEW_PREFIXES: [&str; 2] = ["View image ", "<image path="];
/// Tool names (lowercase, after any `mcp__server__` prefix) of file readers, whose
/// output may begin with a `VIEW_PREFIXES` line for an image they read.
const READ_TOOL_NAMES: [&str; 7] = ["read", "read_file", "read file", "readfile", "view", "readmediafile", "read_media_file"];
/// A file reader named for what it reads (Kimi's `Reading media: <path>`).
const READING_PREFIX: &str = "reading ";
/// Output fragments of a tool call that was denied, blocked or interrupted: such
/// a record never ran, so nothing in it authorizes.
const REFUSAL_MARKERS: [&str; 6] = [
    "Permission to use",
    "has been denied",
    "<tool_use_error>Blocked",
    "The user doesn't want to proceed",
    "[Request interrupted",
    "[PandaCode was interrupted",
];

/// Positive answers only, oldest first: (session, path, when it was found).
pub(crate) struct ViewedCache(VecDeque<(String, String, Instant)>, Duration);

impl ViewedCache {
    const fn new(ttl: Duration) -> Self {
        Self(VecDeque::new(), ttl)
    }

    /// Drops entries older than the TTL. Entries are pushed in time order, so
    /// the expired ones are all at the front.
    fn drop_expired(&mut self, now: Instant) {
        while self.0.front().is_some_and(|(_, _, at)| now.saturating_duration_since(*at) >= self.1) {
            self.0.pop_front();
        }
    }

    fn hit(&mut self, sid: &str, path: &str, now: Instant) -> bool {
        self.drop_expired(now);
        self.0.iter().any(|(s, p, _)| s == sid && p == path)
    }

    /// Re-finding a pair refreshes it: it moves to the back with the new time.
    fn remember(&mut self, sid: &str, path: &str, now: Instant) {
        self.drop_expired(now);
        self.0.retain(|(s, p, _)| !(s == sid && p == path));
        while self.0.len() >= VIEWED_CACHE_SIZE {
            self.0.pop_front();
        }
        self.0.push_back((sid.to_owned(), path.to_owned(), now));
    }
}

static VIEWED: Mutex<ViewedCache> = Mutex::new(ViewedCache::new(VIEWED_TTL));
/// Misses, keyed by the session's newest message id and the path: a new tool
/// record changes the key, so only a rescan of unchanged records is skipped.
static MISSED: Mutex<ViewedCache> = Mutex::new(ViewedCache::new(MISSED_TTL));

fn newest_message(store: &Mutex<Store>, sid: &str) -> Result<i64, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    store.db.query_row("SELECT COALESCE(MAX(id),0) FROM messages WHERE session_id=?1", [sid], |r| r.get(0)).map_err(|e| e.to_string())
}

pub(crate) fn cached_viewed(sid: &str, path: &str) -> bool {
    VIEWED.lock().is_ok_and(|mut cache| cache.hit(sid, path, Instant::now()))
}

fn remember_viewed(sid: &str, path: &str) {
    if let Ok(mut cache) = VIEWED.lock() {
        cache.remember(sid, path, Instant::now());
    }
}

/// Refuses sessions whose agent runs on another computer: a remote mirror or
/// machine thread (`remote_device`) or a cloud task (`cloud`). Their tool records
/// name paths on that machine, so serving this Mac's file of the same name would
/// show the wrong image. Asked on every request, since a task can move.
pub fn ensure_on_this_machine(store: &Mutex<Store>, sid: &str) -> Result<(), String> {
    use rusqlite::OptionalExtension;
    let store = store.lock().map_err(|e| e.to_string())?;
    let elsewhere: bool = store
        .db
        .query_row("SELECT remote_device IS NOT NULL OR cloud IS NOT NULL FROM sessions WHERE id=?1", [sid], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| String::from("Conversation not found."))?;
    if elsewhere {
        Err(crate::tool_images::ERR_ELSEWHERE.into())
    } else {
        Ok(())
    }
}

/// The positive-answer cache key for a request: its first absolute spelling. For
/// an absolute request that is the path itself; for a relative one it is the path
/// joined to the (canonical) checkout root, so a grant made under one root is never
/// reused for the same relative name under another. `requested` is the fallback.
fn cache_key<'a>(requested: &'a str, spellings: &'a [String]) -> &'a str {
    spellings.iter().map(String::as_str).find(|spelling| std::path::Path::new(spelling).is_absolute()).unwrap_or(requested)
}

/// Whether one of `sid`'s tool records names any of `spellings` in an image-bearing
/// place. `key` is the requested path; the positive-answer cache is keyed by
/// `cache_key`. Candidate rows are fetched in batches of `CANDIDATE_BATCH`, newest
/// first, with the store lock held only for each fetch, up to `CANDIDATE_SCAN_LIMIT` rows.
pub fn session_viewed(store: &Mutex<Store>, sid: &str, key: &str, spellings: &[String]) -> Result<bool, String> {
    let key = cache_key(key, spellings);
    if cached_viewed(sid, key) {
        return Ok(true);
    }
    let Some(first) = spellings.first() else { return Ok(false) };
    let missed = format!("{}\n{key}", newest_message(store, sid)?);
    if MISSED.lock().is_ok_and(|mut cache| cache.hit(sid, &missed, Instant::now())) {
        return Ok(false);
    }
    let fragment = search_fragment(first);
    let (mut before, mut scanned) = (None, 0);
    while scanned < CANDIDATE_SCAN_LIMIT {
        let batch = CANDIDATE_BATCH.min(CANDIDATE_SCAN_LIMIT - scanned);
        let rows = {
            let store = store.lock().map_err(|e| e.to_string())?;
            store.tool_records_containing(sid, &fragment, before, batch)?
        };
        let Some(&(oldest, _)) = rows.last() else { break };
        let full = rows.len() == batch;
        scanned += rows.len();
        before = Some(oldest);
        let records: Vec<String> = rows.into_iter().map(|(_, content)| content).collect();
        if records_name_path(&records, spellings, cfg!(windows)) {
            remember_viewed(sid, key);
            return Ok(true);
        }
        if !full {
            break;
        }
    }
    if let Ok(mut cache) = MISSED.lock() {
        cache.remember(sid, &missed, Instant::now());
    }
    Ok(false)
}

/// A piece of the file name that reads the same however many times the record
/// was JSON-escaped: the longest run without `"`, `\` or control characters.
/// Non-ASCII is kept: records are saved as UTF-8, not `\u`-escaped.
pub fn search_fragment(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    name.split(|c: char| c.is_control() || c == '"' || c == '\\')
        .max_by_key(|run| run.len())
        .unwrap_or_default()
        .to_owned()
}

/// The texts of one record that may name a viewed image.
#[derive(Default)]
struct ImageTexts {
    /// Must mention the path as a whole path somewhere.
    mentions: Vec<String>,
    /// Must be exactly the path (trimmed, quotes and `file://` dropped).
    exact: Vec<String>,
    /// Must start with the path (what follows a `Saved to ` or `View image `).
    leading: Vec<String>,
}

impl ImageTexts {
    fn name(&self, path: &str, slashes: impl Fn(&str) -> String) -> bool {
        self.mentions.iter().any(|text| text_mentions_path(&slashes(text), path))
            || self.exact.iter().any(|text| exact_path(&slashes(text)) == path)
            || self.leading.iter().any(|text| starts_with_path(&slashes(text), path))
    }
}

/// True when one of the saved tool records names a spelling of the path in an
/// image-bearing place (see the module notes). Directory listings, shell output,
/// messages and page text do not count. With `windows`, `\` and `/` are the same
/// separator.
pub fn records_name_path(records: &[String], spellings: &[String], windows: bool) -> bool {
    let slashes = |s: &str| if windows { s.replace('\\', "/") } else { s.to_owned() };
    let spellings: Vec<String> = spellings.iter().filter(|s| !s.is_empty()).map(|s| slashes(s)).collect();
    if spellings.is_empty() {
        return false;
    }
    records.iter().any(|content| {
        let Ok(value) = serde_json::from_str::<Value>(content) else { return false };
        let texts = image_texts(&value);
        spellings.iter().any(|path| texts.name(path, slashes))
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ToolKind {
    /// Captures or shows an image: image-path-shaped output lines count.
    Image,
    /// Reads a file: a `VIEW_PREFIXES` output start counts.
    Read,
    /// Prints page text: its output never counts.
    TextSnapshot,
    Other,
}

fn tool_kind(name: &str) -> ToolKind {
    let lower = name.to_lowercase();
    if TEXT_SNAPSHOT_WORDS.iter().any(|word| lower.contains(word)) {
        ToolKind::TextSnapshot
    } else if tool_names::is_image_tool(&lower) {
        ToolKind::Image
    } else if is_read_tool(&lower) {
        ToolKind::Read
    } else {
        ToolKind::Other
    }
}

/// `lower` is a lowercase tool name.
fn is_read_tool(lower: &str) -> bool {
    let base = lower.rsplit("__").next().unwrap_or(lower).trim();
    READ_TOOL_NAMES.contains(&base) || base.starts_with(READING_PREFIX)
}

fn image_texts(value: &Value) -> ImageTexts {
    let mut texts = ImageTexts::default();
    if value["type"] != "tool_activity" || value["status"] != "completed" || refused(&value["output"]) {
        return texts;
    }
    let input = &value["input"];
    collect_strings(input, NESTED_JSON_DEPTH, false, &mut texts.mentions);
    if let Some(text) = input.as_str().filter(|text| parse_nested(text).is_none()) {
        texts.exact.push(text.to_owned());
    }
    let name = value["name"].as_str().unwrap_or_default();
    if let Some(kind) = shell::shell_tool(&name.to_lowercase()) {
        shell::image_outputs(input, kind, &mut texts.exact);
    }
    let kind = tool_kind(name);
    if !matches!(kind, ToolKind::Image | ToolKind::Read) {
        return texts;
    }
    let output = &value["output"];
    let mut strings = Vec::new();
    collect_strings(output, NESTED_JSON_DEPTH, true, &mut strings);
    for text in &strings {
        let head = text.trim_start();
        if let Some(rest) = VIEW_PREFIXES.iter().find_map(|prefix| head.strip_prefix(prefix)) {
            texts.leading.push(rest.lines().next().unwrap_or_default().to_owned());
        }
    }
    if kind == ToolKind::Image {
        // Kimi names the tool `Reading media: <path>`.
        texts.mentions.push(name.to_owned());
        collect_strings(output, NESTED_JSON_DEPTH, false, &mut texts.exact);
        strings.iter().flat_map(|text| text.lines()).for_each(|line| capture_line(line, &mut texts));
    }
    texts
}

/// Whether a record's output says the call was denied, blocked or interrupted.
fn refused(output: &Value) -> bool {
    let mut strings = Vec::new();
    collect_strings(output, NESTED_JSON_DEPTH, true, &mut strings);
    strings.iter().any(|text| REFUSAL_MARKERS.iter().any(|marker| text.contains(marker)))
}

/// One line of an image tool's output: the whole line may be the path, or it
/// may report where the capture was saved.
fn capture_line(line: &str, texts: &mut ImageTexts) {
    let line = line.trim();
    let line = line.strip_prefix("- ").unwrap_or(line);
    texts.exact.push(line.to_owned());
    let starts = |prefix: &str| line.get(..prefix.len()).is_some_and(|head| head.eq_ignore_ascii_case(prefix));
    if let Some(prefix) = CAPTURE_PREFIXES.iter().find(|prefix| starts(prefix)) {
        texts.leading.push(line[prefix.len()..].to_owned());
    } else if starts(TOOK_PREFIX) {
        if let Some(at) = line.to_ascii_lowercase().find(TOOK_SAVED) {
            texts.leading.push(line[at + TOOK_SAVED.len()..].to_owned());
        }
    }
}

/// A string holding a JSON object or array, parsed.
fn parse_nested(text: &str) -> Option<Value> {
    let trimmed = text.trim_start();
    if !(trimmed.starts_with('{') || trimmed.starts_with('[')) {
        return None;
    }
    serde_json::from_str::<Value>(text).ok().filter(|v| v.is_object() || v.is_array())
}

/// String values in `value` that sit under an `IMAGE_FIELDS` key (every string
/// when `take` is already true), unwrapping strings that are themselves JSON
/// objects or arrays up to `depth` times. Object keys are never collected.
fn collect_strings(value: &Value, depth: usize, take: bool, out: &mut Vec<String>) {
    match value {
        Value::String(text) => {
            if depth > 0 {
                if let Some(inner) = parse_nested(text) {
                    collect_strings(&inner, depth - 1, take, out);
                }
            }
            if take {
                out.push(text.clone());
            }
        }
        Value::Array(items) => items.iter().for_each(|item| collect_strings(item, depth, take, out)),
        Value::Object(map) => map
            .iter()
            .for_each(|(key, item)| collect_strings(item, depth, take || IMAGE_FIELDS.contains(&key.as_str()), out)),
        _ => {}
    }
}

const QUOTES: [char; 3] = ['"', '\'', '`'];

/// The text as a bare path: trimmed, one pair of quotes and a `file://` prefix dropped.
fn exact_path(text: &str) -> &str {
    let text = text.trim();
    let text = QUOTES
        .iter()
        .find_map(|quote| text.strip_prefix(*quote).and_then(|rest| rest.strip_suffix(*quote)))
        .unwrap_or(text);
    text.strip_prefix("file://").unwrap_or(text)
}

/// True when `text` (after an optional quote and `file://`) begins with `path`
/// as a whole path.
fn starts_with_path(text: &str, path: &str) -> bool {
    let text = text.trim_start();
    let text = text.strip_prefix(QUOTES).unwrap_or(text);
    let text = text.strip_prefix("file://").unwrap_or(text);
    !path.is_empty() && text.strip_prefix(path).is_some_and(ends_clean)
}

/// True when `text` names `path` as a whole path, not as the tail of a longer
/// one (`/a.png` is not named by `/tmp/a.png`) or the head of another file
/// (`/tmp/a.png` is not named by `/tmp/a.png.txt`). `file://` prefixes count.
pub fn text_mentions_path(text: &str, path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    text.match_indices(path).any(|(start, _)| {
        let before = &text[..start];
        let starts_clean = before.ends_with("file://")
            || before.chars().next_back().is_none_or(|c| !is_path_char(c));
        starts_clean && ends_clean(&text[start + path.len()..])
    })
}

/// What follows a path does not continue it (a trailing full stop is fine).
fn ends_clean(after: &str) -> bool {
    after.chars().next().is_none_or(|c| !is_path_char(c) || (c == '.' && !after[1..].starts_with(is_path_char)))
}

fn is_path_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | '~' | '+' | '@' | '%')
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::tool_images::path_spellings;

    fn named(name: &str, input: Value, output: &str) -> String {
        serde_json::json!({"type": "tool_activity", "version": 1, "name": name, "status": "completed", "input": input, "output": output}).to_string()
    }

    fn record(input: Value, output: &str) -> String {
        named("Read", input, output)
    }

    fn named_by(records: &[String], path: &str) -> bool {
        records_name_path(records, &path_spellings(path), false)
    }

    #[test]
    fn tool_image_mentions_need_whole_paths() {
        assert!(text_mentions_path("Reading media: /tmp/a.png", "/tmp/a.png"));
        assert!(text_mentions_path("/tmp/a.png", "/tmp/a.png"));
        assert!(text_mentions_path("saw file:///tmp/a.png.", "/tmp/a.png"));
        assert!(text_mentions_path("\"/tmp/a b.png\"", "/tmp/a b.png"));
        assert!(!text_mentions_path("/tmp/a.png", "/a.png"));
        assert!(!text_mentions_path("/tmp/a.png.txt", "/tmp/a.png"));
        assert!(!text_mentions_path("/tmp/a.pngx", "/tmp/a.png"));
        assert!(!text_mentions_path("x/tmp/a.png", "/tmp/a.png"));
        assert!(text_mentions_path("x/tmp/a.png and /tmp/a.png", "/tmp/a.png"));
        assert!(!text_mentions_path("anything", ""));
    }

    #[test]
    fn tool_image_leading_and_exact_paths() {
        assert!(starts_with_path(" \"/tmp/a b.png\" (10x10)", "/tmp/a b.png"));
        assert!(starts_with_path("file:///tmp/a.png.", "/tmp/a.png"));
        assert!(!starts_with_path("/tmp/a.png.txt", "/tmp/a.png"));
        assert!(!starts_with_path("see /tmp/a.png", "/tmp/a.png"));
        assert!(!starts_with_path("anything", ""));
        assert_eq!(exact_path(" `file:///tmp/a.png` "), "/tmp/a.png");
        assert_eq!(exact_path("'/tmp/a.png'"), "/tmp/a.png");
    }

    #[test]
    fn tool_image_search_fragment_survives_escaping() {
        assert_eq!(search_fragment("/tmp/shot.png"), "shot.png");
        assert_eq!(search_fragment("C:\\Users\\me\\shot one.png"), "shot one.png");
        // Non-ASCII is kept, so the fragment is the whole name.
        assert_eq!(search_fragment("/tmp/Screenshot at 10.00\u{202f}AM.png"), "Screenshot at 10.00\u{202f}AM.png");
        assert_eq!(search_fragment("/tmp/é.png"), "é.png");
        assert_eq!(search_fragment("/tmp/a\"b.png"), "b.png");
        // The fragment appears in the record however deeply it was JSON-encoded.
        let path = "C:\\a\\shot.png";
        let twice = serde_json::to_string(&serde_json::to_string(&serde_json::json!({"file_path": path})).unwrap()).unwrap();
        assert!(twice.contains(&search_fragment(path)));
    }

    #[test]
    fn tool_image_records_match_parsed_values_only() {
        let records = vec![
            record(serde_json::json!({"file_path": "/tmp/shot.png"}), ""),
            named("Reading media: /private/tmp/kimi.png", Value::String(String::new()), ""),
            r#"{"type":"tool_activity","name":"/tmp/named.png","input":"","output":""}"#.to_owned(),
            r#"{"type":"user","input":"/tmp/typed.png"}"#.to_owned(),
            record(serde_json::json!({"/tmp/key.png": 1}), ""),
            "not json /tmp/raw.png".to_owned(),
        ];
        assert!(named_by(&records, "/tmp/shot.png"));
        assert!(named_by(&records, "/tmp/kimi.png"));
        assert!(!named_by(&records, "/shot.png"));
        assert!(!named_by(&records, "/tmp/named.png"));
        assert!(!named_by(&records, "/tmp/typed.png"));
        assert!(!named_by(&records, "/tmp/key.png"));
        assert!(!named_by(&records, "/tmp/raw.png"));
        assert!(!records_name_path(&records, &[String::new()], false));
    }

    #[test]
    fn tool_image_only_image_bearing_places_authorize() {
        let path = "/tmp/shot.png";
        let reject = [
            named("Bash", serde_json::json!({"command": "ls /tmp"}), "notes.txt\n/tmp/shot.png\n"),
            named("Bash", serde_json::json!({"command": "open /tmp/shot.png"}), ""),
            named("Glob", serde_json::json!({"pattern": "*.png"}), "/tmp/shot.png"),
            named("pandacode_read_team_mailbox", Value::Null, "Please look at /tmp/shot.png"),
            named("Read", serde_json::json!({"file_path": "/tmp/notes.md"}), "see /tmp/shot.png"),
            named("Bash", Value::String("ls /tmp/shot.png".into()), ""),
            named("WebFetch", Value::Null, r#"{"path": "/tmp/shot.png"}"#),
            named("WebFetch", Value::Null, "intro\nView image /tmp/shot.png"),
            named("WebFetch", Value::Null, "View image /tmp/shot.png"),
            named("WebFetch", Value::Null, "<image path=/tmp/shot.png>"),
            named("Bash", Value::Null, "View image /tmp/shot.png"),
            named("mcp__web__fetch", Value::Null, r#"[{"type":"text","text":"<image path=/tmp/shot.png>"}]"#),
            named("mcp__capture_notes__save", Value::Null, "/tmp/shot.png"),
            named("mcp__screenshot_store__save", Value::Null, "Saved to /tmp/shot.png"),
            named("mcp__notes__recapture_page", Value::Null, "/tmp/shot.png"),
            named("mcp__notes__save_snapshot", Value::Null, "Saved to /tmp/shot.png"),
            named("Running: curl https://site/capture", Value::Null, "/tmp/shot.png"),
        ];
        for record in &reject {
            assert!(!named_by(std::slice::from_ref(record), path), "{record}");
        }
        let accept = [
            named("Read", serde_json::json!({"file_path": path}), ""),
            named("Edit", serde_json::json!({"edits": [{"filePath": path}]}), ""),
            named("x", serde_json::json!({"args": {"image_path": path}}), ""),
            named("x", serde_json::json!({"screenshot": {"saved": path}}), ""),
            named("x", serde_json::json!({"savedPath": path}), ""),
            named("mcp__pw__browser_take_screenshot", Value::Null, "Saved to /tmp/shot.png"),
            named("mcp__chrome-devtools__take_screenshot", Value::Null, "Saved screenshot to /tmp/shot.png"),
            named("mcp__pandacode_architect__pandacode_vm_screenshot", Value::Null, path),
            named("Capture window", Value::Null, path),
            named("Generate image", serde_json::json!({"revisedPrompt": "a cat"}), path),
            named("View image", Value::Null, "/private/tmp/shot.png"),
            named("Read file", Value::Null, "View image /tmp/shot.png (10x10)"),
            named("ReadMediaFile", Value::Null, r#"[{"type":"text","text":"<image path=/tmp/shot.png>"}]"#),
            named("ReadMediaFile", Value::String(path.into()), ""),
            named("Read", Value::Null, "View image /tmp/shot.png"),
            named("read_file", Value::Null, "<image path=/tmp/shot.png>"),
            named("mcp__fs__read_file", Value::Null, "View image /tmp/shot.png"),
            named("view", Value::Null, "View image /tmp/shot.png"),
            named("Reading file: shot.png", Value::Null, "<image path=/tmp/shot.png>"),
            named("ViewImage", Value::Null, "View image /tmp/shot.png"),
        ];
        for record in &accept {
            assert!(named_by(std::slice::from_ref(record), path), "{record}");
        }
    }

    #[test]
    fn tool_image_shell_created_images_are_accepted() {
        let path = "/tmp/shot.png";
        let shell = |name: &str, command: &str, status: &str| {
            serde_json::json!({"type": "tool_activity", "version": 1, "name": name, "status": status,
                "input": {"command": command}, "output": ""}).to_string()
        };
        for name in ["Bash", "bash", "Command", "shell"] {
            assert!(named_by(&[shell(name, "screencapture -x /tmp/shot.png", "completed")], path), "{name}");
        }
        // The /private spelling of the same file.
        assert!(named_by(&[shell("Bash", "screencapture /private/tmp/shot.png", "completed")], path));
        let reject = [
            shell("Bash", "cat /tmp/shot.png", "completed"),
            shell("Bash", "ls /tmp/shot.png", "completed"),
            shell("Bash", "screencapture /tmp/shot.png", "failed"),
            shell("Bash", "screencapture /tmp/shot.png", "running"),
            shell("WebFetch", "screencapture /tmp/shot.png", "completed"),
            shell("Bash", "screencapture /tmp/shot.png.txt", "completed"),
        ];
        for record in &reject {
            assert!(!named_by(std::slice::from_ref(record), path), "{record}");
        }
    }

    /// Every fixture case with a `tool` is a whole record: its name and raw input text.
    /// `served` (when present) overrides `produced` for the record.
    #[test]
    fn tool_image_shell_records_match_the_shared_fixture() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("../../tests/fixtures/produced-images.json")).expect("fixture parses");
        let records: Vec<&Value> = cases.iter().filter(|case| case.get("tool").is_some()).collect();
        assert!(records.len() >= 6);
        for case in records {
            let (tool, input) = (case["tool"].as_str().expect("tool"), case["input"].as_str().expect("input"));
            let record = named(tool, Value::String(input.to_owned()), "");
            let expected = case.get("served").unwrap_or(&case["produced"]);
            match expected.as_str() {
                Some(path) => assert!(named_by(std::slice::from_ref(&record), path), "{tool}: {input}"),
                None => {
                    let command = case["command"].as_str().expect("command");
                    for word in command.split_whitespace().filter(|word| word.ends_with(".png")) {
                        assert!(!named_by(std::slice::from_ref(&record), word), "{tool}: {word}");
                    }
                }
            }
        }
    }

    #[test]
    fn tool_image_shell_records_of_every_harness_are_accepted() {
        let path = "/tmp/shot.png";
        let json = |command: Value| serde_json::json!({"command": command}).to_string();
        let accept = [
            ("Ran screencapture", json("screencapture /tmp/shot.png".into())),
            ("Running: screencapture /tmp/sh…", json("screencapture /tmp/shot.png".into())),
            ("Running: screencapture /tmp/shot.png", "screencapture /tmp/shot.png".to_owned()),
            ("run_terminal_cmd", json("screencapture /tmp/shot.png".into())),
            ("exec_command", serde_json::json!({"cmd": "screencapture /tmp/shot.png"}).to_string()),
            ("local_shell", json(serde_json::json!(["screencapture", "/tmp/shot.png"]))),
            ("mcp__x__shell", json("screencapture /tmp/shot.png".into())),
            ("Ran screencapture", serde_json::json!({"command": "screencapture shot.png", "workdir": "/tmp"}).to_string()),
            ("shell", serde_json::json!({"command": ["screencapture", "shot.png"], "cwd": "/private/tmp/"}).to_string()),
            ("Command", "/bin/zsh -lc \"screencapture shot.png\"\nWorking directory: /tmp".to_owned()),
        ];
        for (name, input) in &accept {
            assert!(named_by(&[named(name, Value::String(input.clone()), "")], path), "{name}: {input}");
        }
        let reject = [
            // Devin's plain-text input on a `Ran` title is the command's output, not the command.
            ("Ran screencapture", "screencapture /tmp/shot.png".to_owned()),
            ("Ran ls", json("ls /tmp/shot.png".into())),
            ("pandacode_vm_exec", json("screencapture /tmp/shot.png".into())),
            ("mcp__pandacode__pandacode_vm_exec", json("screencapture /tmp/shot.png".into())),
            ("Rand", json("screencapture /tmp/shot.png".into())),
            ("Running", json("screencapture /tmp/shot.png".into())),
            // A relative output under another working directory is another file.
            ("Ran screencapture", serde_json::json!({"command": "screencapture shot.png", "workdir": "/var"}).to_string()),
        ];
        for (name, input) in &reject {
            assert!(!named_by(&[named(name, Value::String(input.clone()), "")], path), "{name}: {input}");
        }
        // The relative output is named only as joined to the working directory.
        let joined = named("Ran screencapture", Value::String(serde_json::json!({"command": "screencapture a.png", "workdir": "/w"}).to_string()), "");
        assert!(named_by(std::slice::from_ref(&joined), "/w/a.png"));
        assert!(!named_by(std::slice::from_ref(&joined), "a.png"));
    }

    #[test]
    fn tool_image_view_prefixes_need_an_image_or_read_tool() {
        let path = "/Users/x/a.png";
        assert!(!named_by(&[named("WebFetch", Value::Null, "View image /Users/x/a.png")], path));
        assert!(!named_by(&[named("WebFetch", Value::Null, "<image path=/Users/x/a.png>")], path));
        // Devin reads an image with `Read file`.
        assert!(named_by(&[named("Read file", Value::Null, "View image /Users/x/a.png")], path));
        assert!(named_by(&[named("View image", Value::Null, "View image /Users/x/a.png")], path));
    }

    #[test]
    fn tool_image_hostile_snapshot_text_is_rejected() {
        let path = "/Users/me/secret.png";
        let page = "- heading \"Saved to /Users/me/secret.png\"\n/Users/me/secret.png\nScreenshot saved: /Users/me/secret.png\n\
                    View image /Users/me/secret.png\n<image path=/Users/me/secret.png>";
        let reject = [
            named("mcp__playwright__browser_snapshot", Value::Null, page),
            named("mcp__chrome-devtools__take_snapshot", Value::Null, page),
            named("get_accessibility_tree", Value::Null, page),
            named("mcp__playwright__browser_snapshot", Value::Null, r#"{"path": "/Users/me/secret.png"}"#),
            // An image tool's output names the path only in prose (a page title, say).
            named("mcp__pw__browser_take_screenshot", Value::Null, "- Page Title: look at /Users/me/secret.png now"),
            named("Capture window", Value::Null, "Window title: /Users/me/secret.png.txt"),
        ];
        for record in &reject {
            assert!(!named_by(std::slice::from_ref(record), path), "{record}");
        }
    }

    #[test]
    fn tool_image_real_screenshot_outputs_are_accepted() {
        let path = "/var/folders/x/page-1.png";
        let accept = [
            named("mcp__playwright__browser_take_screenshot", Value::Null,
                "### Result\nTook the viewport screenshot and saved it as /var/folders/x/page-1.png\n\n### Page\n- Page Title: Home"),
            named("mcp__pw__browser_take_screenshot", Value::Null, "Screenshot saved: /private/var/folders/x/page-1.png"),
            named("simulator_screenshot", Value::Null, r#"{"ok": true, "path": "/var/folders/x/page-1.png"}"#),
            named("vm_screenshot", Value::Null, r#"[{"type":"text","text":"{\"image\":\"file:///var/folders/x/page-1.png\"}"}]"#),
            named("Screen capture", Value::Null, "Captured window 42\n  `/var/folders/x/page-1.png`  "),
            named("mcp__pandacode__pandacode_capture_browser", Value::Null,
                r#"{"path": "/var/folders/x/page-1.png", "width": 1280, "height": 800}"#),
            named("mcp__puppeteer__puppeteer_screenshot", Value::Null, "Screenshot saved: /var/folders/x/page-1.png"),
        ];
        for record in &accept {
            assert!(named_by(std::slice::from_ref(record), path), "{record}");
        }
    }

    #[test]
    fn tool_image_progress_snapshot_input_is_accepted() {
        let input = serde_json::json!({"title": "Home", "image": ".pandacode/progress-shots/home.png"});
        let records = vec![named("mcp__pandacode__pandacode_progress_snapshot", input, "Posted snapshot 3")];
        let spellings = crate::tool_images::relative_spellings(Path::new(".pandacode/progress-shots/home.png"), Path::new("/w"));
        assert!(records_name_path(&records, &spellings, false));
        let other = crate::tool_images::relative_spellings(Path::new(".pandacode/progress-shots/other.png"), Path::new("/w"));
        assert!(!records_name_path(&records, &other, false));
    }

    #[test]
    fn tool_image_records_unwrap_nested_json_strings() {
        let deeper = serde_json::json!({"image_path": "/tmp/deep.png", "p": "/tmp/plain.png"}).to_string();
        let inner = serde_json::json!({"file_path": "/tmp/nested.png", "deeper": deeper}).to_string();
        let records = vec![record(Value::String(inner), "")];
        assert!(named_by(&records, "/tmp/nested.png"));
        assert!(named_by(&records, "/tmp/deep.png"));
        assert!(!named_by(&records, "/tmp/plain.png"));
        assert!(!named_by(&records, "/tmp/nested.pn"));
    }

    #[test]
    fn tool_image_records_match_windows_paths() {
        let path = "C:\\Users\\me\\shot.png";
        let nested = serde_json::json!({"file_path": path}).to_string();
        let records = vec![record(Value::String(nested), "")];
        // The nested string is unwrapped, so the exact path matches everywhere.
        assert!(records_name_path(&records, &[path.to_owned()], false));
        assert!(records_name_path(&records, &[path.to_owned()], true));
        // Mixed separators only match on Windows.
        assert!(records_name_path(&records, &["C:/Users/me/shot.png".to_owned()], true));
        assert!(!records_name_path(&records, &["C:/Users/me/shot.png".to_owned()], false));
        // Whole-path boundaries still hold with `\\` separators.
        assert!(!records_name_path(&records, &["C:\\Users\\me\\shot.pn".to_owned()], true));
        assert!(!records_name_path(&records, &["\\me\\shot.png".to_owned()], true));
        let saved = vec![named("Take screenshot", Value::Null, "Saved to C:\\Users\\me\\shot.png.")];
        assert!(records_name_path(&saved, &[path.to_owned()], true));
        assert!(records_name_path(&saved, &["C:/Users/me/shot.png".to_owned()], true));
    }

    #[test]
    fn tool_image_pages_past_the_first_batch() {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let session = store.create_session(&project.id, "claude", "sonnet", "auto").unwrap();
        let path = "/tmp/paged-shot.png";
        store.message(&session.id, "tool", &record(serde_json::json!({"file_path": path}), "")).unwrap();
        // Newer listings mention the name but do not authorize it.
        for _ in 0..CANDIDATE_BATCH * 2 + 5 {
            store.message(&session.id, "tool", &named("Bash", serde_json::json!({"command": "ls /tmp"}), path)).unwrap();
        }
        let store = Mutex::new(store);
        assert!(session_viewed(&store, &session.id, path, &path_spellings(path)).unwrap());
        let other = "/tmp/other-paged.png";
        assert!(!session_viewed(&store, &session.id, other, &path_spellings(other)).unwrap());
    }

    #[test]
    fn tool_image_cache_key_is_the_resolved_path() {
        let relative = crate::tool_images::relative_spellings(Path::new("a.png"), Path::new("/w"));
        assert_eq!(cache_key("a.png", &relative), "/w/a.png");
        let other = crate::tool_images::relative_spellings(Path::new("a.png"), Path::new("/v"));
        assert_ne!(cache_key("a.png", &relative), cache_key("a.png", &other));
        assert_eq!(cache_key("/tmp/a.png", &path_spellings("/tmp/a.png")), "/tmp/a.png");
        assert_eq!(cache_key("a.png", &["a.png".to_owned()]), "a.png");
    }

    #[test]
    fn tool_image_viewed_cache_is_bounded() {
        let mut cache = ViewedCache::new(VIEWED_TTL);
        let now = Instant::now();
        for n in 0..VIEWED_CACHE_SIZE + 10 {
            cache.remember("cache-test", &format!("/tmp/{n}.png"), now);
        }
        assert_eq!(cache.0.len(), VIEWED_CACHE_SIZE);
        assert!(!cache.hit("cache-test", "/tmp/0.png", now));
        assert!(cache.hit("cache-test", &format!("/tmp/{}.png", VIEWED_CACHE_SIZE + 9), now));
    }

    #[test]
    fn tool_image_viewed_cache_entries_expire() {
        let mut cache = ViewedCache::new(VIEWED_TTL);
        let start = Instant::now();
        cache.remember("s", "/tmp/a.png", start);
        cache.remember("s", "/tmp/b.png", start + VIEWED_TTL / 2);
        let late = start + VIEWED_TTL;
        assert!(!cache.hit("s", "/tmp/a.png", late));
        assert!(cache.hit("s", "/tmp/b.png", late));
        assert_eq!(cache.0.len(), 1);
        // Finding the pair again restarts its clock.
        cache.remember("s", "/tmp/b.png", late);
        assert!(cache.hit("s", "/tmp/b.png", late + VIEWED_TTL / 2 + VIEWED_TTL / 4));
        assert!(!cache.hit("s", "/tmp/b.png", late + VIEWED_TTL));
    }
}
