//! Design canvas: artboards are HTML files in the task checkout under
//! `.pandacode/design/`, so turn changes, diffs and worktree merges cover them.
//! Comments on artboard elements live beside them in `comments.json`.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::UNIX_EPOCH,
};
use tauri::{Emitter, Manager, State};

use crate::{agent_tools::{spec, validate_spec}, providers::ToolHost, AppState};

type Result<T> = std::result::Result<T, String>;

pub const DIR: &str = ".pandacode/design";
const COMMENTS: &str = "comments.json";
/// Artboards on disk (agents may write them with their own editors).
const MAX_ARTBOARD: u64 = 512 * 1024;
/// Artboards through `pandacode_design_write`; the MCP body limit is 160 KiB.
const MAX_TOOL_ARTBOARD: usize = 128 * 1024;
const MAX_ARTBOARDS: usize = 100;
const MAX_COMMENTS_FILE: u64 = 512 * 1024;
const MAX_COMMENTS: usize = 500;
const MAX_TEXT: usize = 4000;
const MAX_SELECTOR: usize = 1024;
const READ_ONLY: [&str; 2] = ["pandacode_design_list", "pandacode_design_comments"];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Artboard {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Bbox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Open,
    Resolved,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub artboard: String,
    pub selector: String,
    pub bbox: Bbox,
    pub text: String,
    pub status: Status,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// `name.html`: letters, digits, `.`, `_`, `-`; no hidden files, no separators.
pub fn artboard_name(name: &str) -> Result<String> {
    let name = name.trim();
    let name = if name.ends_with(".html") { name.to_owned() } else { format!("{name}.html") };
    let stem = &name[..name.len() - 5];
    let valid = (1..=64).contains(&stem.len())
        && !stem.starts_with('.') && !stem.ends_with('.')
        && !stem.contains("..")
        && stem.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if valid { Ok(name) } else { Err("Artboard names use letters, digits, '.', '_' and '-' (up to 64), ending in .html.".into()) }
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// The design folder; `create` makes it. Each step must be a real folder inside `root`.
fn design_dir(root: &Path, create: bool) -> Result<Option<PathBuf>> {
    let root = root.canonicalize().map_err(|_| "Checkout is unavailable.")?;
    let mut dir = root.clone();
    for part in DIR.split('/') {
        dir.push(part);
        match fs::symlink_metadata(&dir) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => return Err(format!("{DIR} must be a folder, not a link.")),
            Ok(_) => {}
            Err(_) if create => fs::create_dir(&dir).map_err(|e| format!("Could not create {DIR}: {e}"))?,
            Err(_) => return Ok(None),
        }
    }
    let dir = dir.canonicalize().map_err(|e| e.to_string())?;
    if !dir.starts_with(&root) { return Err(format!("{DIR} is outside the checkout.")); }
    Ok(Some(dir))
}

/// Reads a regular, non-linked file up to `limit` bytes; `None` when it is missing.
fn read_bounded(path: &Path, limit: u64) -> Result<Option<String>> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if !meta.is_file() { return Err("Design files must be regular files, not links.".into()); }
    if meta.len() > limit { return Err(format!("{} is larger than {} KiB.", path.file_name().unwrap_or_default().to_string_lossy(), limit / 1024)); }
    let mut text = String::new();
    fs::File::open(path).map_err(|e| e.to_string())?.take(limit + 1).read_to_string(&mut text).map_err(|_| "Design files must be UTF-8 text.")?;
    if text.len() as u64 > limit { return Err("Design file grew while reading.".into()); }
    Ok(Some(text))
}

/// Replaces `path` atomically; never follows a link at the target.
fn write_atomic(path: &Path, text: &str) -> Result<()> {
    if is_symlink(path) { return Err("Design files must be regular files, not links.".into()); }
    let temp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    fs::write(&temp, text).map_err(|e| e.to_string())?;
    fs::rename(&temp, path).map_err(|e| { let _ = fs::remove_file(&temp); e.to_string() })
}

pub fn list(root: &Path) -> Result<Vec<Artboard>> {
    let Some(dir) = design_dir(root, false)? else { return Ok(Vec::new()) };
    let mut boards = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
        let Ok(meta) = fs::symlink_metadata(entry.path()) else { continue };
        if !meta.is_file() || artboard_name(&name).as_deref() != Ok(name.as_str()) { continue; }
        let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
        boards.push(Artboard { path: format!("{DIR}/{name}"), name, size: meta.len(), modified });
    }
    boards.sort_by(|a, b| a.name.cmp(&b.name));
    boards.truncate(MAX_ARTBOARDS);
    Ok(boards)
}

pub fn read(root: &Path, name: &str) -> Result<String> {
    let name = artboard_name(name)?;
    let dir = design_dir(root, false)?.ok_or("There are no artboards yet.")?;
    read_bounded(&dir.join(&name), MAX_ARTBOARD)?.ok_or_else(|| format!("No artboard named {name}."))
}

pub fn write(root: &Path, name: &str, html: &str) -> Result<Artboard> {
    let name = artboard_name(name)?;
    if html.len() > MAX_TOOL_ARTBOARD { return Err(format!("Artboards are limited to {} KiB.", MAX_TOOL_ARTBOARD / 1024)); }
    if html.contains('\0') { return Err("Artboard HTML must be text.".into()); }
    let dir = design_dir(root, true)?.ok_or("Could not create the design folder.")?;
    let path = dir.join(&name);
    if !path.exists() && list(root)?.len() >= MAX_ARTBOARDS { return Err(format!("A checkout holds at most {MAX_ARTBOARDS} artboards.")); }
    write_atomic(&path, html)?;
    list(root)?.into_iter().find(|b| b.name == name).ok_or_else(|| "The artboard was not saved.".into())
}

pub fn comments(root: &Path) -> Result<Vec<Comment>> {
    let Some(dir) = design_dir(root, false)? else { return Ok(Vec::new()) };
    match read_bounded(&dir.join(COMMENTS), MAX_COMMENTS_FILE)? {
        None => Ok(Vec::new()),
        Some(text) => serde_json::from_str(&text).map_err(|e| format!("{DIR}/{COMMENTS} is not valid: {e}")),
    }
}

fn check(comment: &Comment) -> Result<()> {
    artboard_name(&comment.artboard)?;
    let finite = [comment.bbox.x, comment.bbox.y, comment.bbox.width, comment.bbox.height].iter().all(|n| n.is_finite());
    let ok = (1..=64).contains(&comment.id.len())
        && comment.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !comment.selector.is_empty() && comment.selector.len() <= MAX_SELECTOR
        && !comment.text.trim().is_empty() && comment.text.len() <= MAX_TEXT
        && comment.note.as_ref().is_none_or(|n| n.len() <= MAX_TEXT)
        && finite;
    if ok { Ok(()) } else { Err(format!("Comment {} is not valid.", comment.id.chars().take(64).collect::<String>())) }
}

pub fn save_comments(root: &Path, list: &[Comment]) -> Result<()> {
    if list.len() > MAX_COMMENTS { return Err(format!("At most {MAX_COMMENTS} comments.")); }
    list.iter().try_for_each(check)?;
    let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())? + "\n";
    if text.len() as u64 > MAX_COMMENTS_FILE { return Err("Comments are too large.".into()); }
    let dir = design_dir(root, true)?.ok_or("Could not create the design folder.")?;
    write_atomic(&dir.join(COMMENTS), &text)
}

/// Marks one comment resolved, with an optional note from the agent.
pub fn resolve(root: &Path, id: &str, note: Option<String>) -> Result<Comment> {
    let current = comments(root)?;
    let found = current.iter().find(|c| c.id == id).ok_or_else(|| format!("No comment with id {id}."))?;
    let resolved = Comment { status: Status::Resolved, note: note.or_else(|| found.note.clone()), ..found.clone() };
    let next: Vec<Comment> = current.iter().map(|c| if c.id == id { resolved.clone() } else { c.clone() }).collect();
    save_comments(root, &next)?;
    Ok(resolved)
}

// ---- IPC ----

#[tauri::command]
pub async fn design_list(state: State<'_, AppState>, project_id: String, session_id: Option<String>) -> Result<Vec<Artboard>> {
    let root = state.root(&project_id, session_id.as_deref())?;
    crate::blocking(move || list(&root)).await
}
#[tauri::command]
pub async fn design_read(state: State<'_, AppState>, project_id: String, session_id: Option<String>, name: String) -> Result<String> {
    let root = state.root(&project_id, session_id.as_deref())?;
    crate::blocking(move || read(&root, &name)).await
}
#[tauri::command]
pub async fn design_comments(state: State<'_, AppState>, project_id: String, session_id: Option<String>) -> Result<Vec<Comment>> {
    let root = state.root(&project_id, session_id.as_deref())?;
    crate::blocking(move || comments(&root)).await
}
#[tauri::command]
pub async fn design_save_comments(state: State<'_, AppState>, project_id: String, session_id: Option<String>, comments: Vec<Comment>) -> Result<()> {
    let root = state.root(&project_id, session_id.as_deref())?;
    crate::blocking(move || save_comments(&root, &comments)).await
}

// ---- Agent tools ----

pub fn catalog() -> Vec<Value> {
    let name = json!({"type":"string","maxLength":72,"description":"e.g. home.html"});
    vec![
        spec("design_list", "Artboards in .pandacode/design/ (PandaCode's Design canvas) and the open comment count.", json!({}), &[]),
        spec("design_write", "Create/replace an artboard: self-contained HTML, inline <style>; scripts don't run, remote assets are blocked. <meta name=\"artboard-width\" content=\"390\"> for phone width (default 1280). ≤128 KiB.", json!({"name":name,"html":{"type":"string"}}), &["name","html"]),
        spec("design_comments", "User feedback on artboard elements (id, artboard, selector, box, text, status). Fix the artboard, then resolve each. status default open.", json!({"status":{"type":"string","enum":["open","resolved","all"]}}), &[]),
        spec("design_resolve", "Resolve a comment, with an optional short note.", json!({"id":{"type":"string","maxLength":64},"note":{"type":"string","maxLength":4000}}), &["id"]),
    ]
}

/// What a harness is shown: the catalog without bounds only the server needs. Lengths and
/// unknown keys are still checked against the full catalog on every call; this saves about a
/// fifth of each tool's bytes on every turn.
pub(crate) fn listed(tools: Vec<Value>) -> Vec<Value> {
    fn strip(value: &mut Value) {
        if let Value::Object(map) = value {
            map.remove("maxLength");
            map.remove("additionalProperties");
            if map.get("required").is_some_and(|r| r.as_array().is_some_and(Vec::is_empty)) {
                map.remove("required");
            }
            map.values_mut().for_each(strip);
        }
    }
    tools.into_iter().map(|mut tool| { strip(&mut tool["inputSchema"]); tool }).collect()
}

/// `design_write` carries a whole document, past `validate_spec`'s 8 KiB strings.
fn validate(name: &str, args: &Value) -> Result<()> {
    if name != "pandacode_design_write" { return validate_spec(&catalog(), name, args); }
    let object = args.as_object().ok_or("Tool arguments must be an object.")?;
    if object.keys().any(|k| k != "name" && k != "html") { return Err("Invalid argument.".into()); }
    let field = |key: &str| object.get(key).and_then(Value::as_str).ok_or(format!("Missing argument: {key}"));
    artboard_name(field("name")?)?;
    field("html").map(|_| ())
}

fn tool(root: &Path, name: &str, args: &Value) -> Result<Value> {
    let text = |key: &str| args[key].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned);
    match name {
        "pandacode_design_list" => {
            let open = comments(root)?.iter().filter(|c| c.status == Status::Open).count();
            Ok(json!({"folder": DIR, "artboards": list(root)?, "openComments": open}))
        }
        "pandacode_design_write" => Ok(json!({"saved": write(root, &text("name").unwrap_or_default(), args["html"].as_str().unwrap_or_default())?})),
        "pandacode_design_comments" => {
            let want = text("status").unwrap_or_else(|| "open".into());
            let all = comments(root)?;
            Ok(json!({"comments": all.into_iter().filter(|c| want == "all" || (want == "open") == (c.status == Status::Open)).collect::<Vec<_>>()}))
        }
        "pandacode_design_resolve" => Ok(json!({"resolved": resolve(root, &text("id").unwrap_or_default(), text("note"))?})),
        _ => Err("Unknown PandaCode tool.".into()),
    }
}

/// The task's checkout; refuses remote mirrors through `Store::workspace_root`.
fn task_root(app: &tauri::AppHandle, session_id: &str) -> Result<PathBuf> {
    let state = app.state::<AppState>();
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let task = store.session(session_id)?;
    store.workspace_root(&task.project_id, Some(session_id))
}

/// Add the design tools to every harness turn.
pub fn with_design(base: Option<ToolHost>, app: tauri::AppHandle, session_id: String, stopped: Arc<AtomicBool>) -> Option<ToolHost> {
    let own = listed(catalog());
    let mut tools = base.as_ref().map_or_else(Vec::new, |host| host.tools.clone());
    let approval_tools = base.as_ref().map_or_else(Default::default, |host| host.approval_tools.clone());
    tools.extend(own);
    Some(ToolHost {
        tools,
        approval_tools,
        handler: Arc::new(move |name, args| {
            let (base, app, stopped, session_id) = (base.clone(), app.clone(), stopped.clone(), session_id.clone());
            Box::pin(async move {
                if stopped.load(Ordering::SeqCst) { return Err("Task has stopped.".into()); }
                if !name.starts_with("pandacode_design_") {
                    return match base { Some(base) => (base.handler)(name, args).await, None => Err("Unknown PandaCode tool.".into()) };
                }
                validate(&name, &args)?;
                let changes = !READ_ONLY.contains(&name.as_str());
                let (emit_app, sid) = (app.clone(), session_id.clone());
                let result = crate::blocking(move || tool(&task_root(&app, &session_id)?, &name, &args)).await?;
                if changes { let _ = emit_app.emit("design-changed", json!({"sessionId": sid})); }
                Ok(result)
            })
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temp(PathBuf);
    impl Drop for Temp { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn checkout() -> Temp {
        let dir = std::env::temp_dir().join(format!("pandacode-design-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        Temp(dir.canonicalize().unwrap())
    }
    fn comment(id: &str) -> Comment {
        Comment { id: id.into(), artboard: "home.html".into(), selector: "body > main > h1".into(), bbox: Bbox { x: 10.0, y: 20.0, width: 300.0, height: 40.0 }, text: "Bigger title".into(), status: Status::Open, created_at: 1, note: None }
    }

    #[test]
    fn names_refuse_traversal_and_hidden_files() {
        assert_eq!(artboard_name("home").unwrap(), "home.html");
        assert_eq!(artboard_name("v2.home-page_x.html").unwrap(), "v2.home-page_x.html");
        for bad in ["../x", "a/b", ".hidden", "a..b", "", "comments.json.", "x y", "é"] { assert!(artboard_name(bad).is_err(), "{bad}"); }
        assert!(artboard_name(&"a".repeat(65)).is_err());
    }

    #[test]
    fn writes_lists_and_reads_artboards() {
        let t = checkout();
        assert!(list(&t.0).unwrap().is_empty());
        let saved = write(&t.0, "home", "<h1>Hi</h1>").unwrap();
        assert_eq!((saved.name.as_str(), saved.path.as_str(), saved.size), ("home.html", ".pandacode/design/home.html", 11));
        fs::write(t.0.join(DIR).join("notes.txt"), "x").unwrap();
        assert_eq!(list(&t.0).unwrap().len(), 1);
        assert_eq!(read(&t.0, "home.html").unwrap(), "<h1>Hi</h1>");
        assert!(read(&t.0, "missing").is_err());
        assert!(write(&t.0, "big", &"x".repeat(MAX_TOOL_ARTBOARD + 1)).is_err());
        fs::write(t.0.join(DIR).join("huge.html"), "x".repeat(MAX_ARTBOARD as usize + 1)).unwrap();
        assert!(read(&t.0, "huge").unwrap_err().contains("larger"));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_escapes() {
        let t = checkout();
        let outside = checkout();
        fs::write(outside.0.join("secret.html"), "secret").unwrap();
        fs::create_dir_all(t.0.join(DIR)).unwrap();
        std::os::unix::fs::symlink(outside.0.join("secret.html"), t.0.join(DIR).join("leak.html")).unwrap();
        assert!(read(&t.0, "leak").is_err());
        assert!(write(&t.0, "leak", "x").is_err());
        assert_eq!(fs::read_to_string(outside.0.join("secret.html")).unwrap(), "secret");
        assert!(list(&t.0).unwrap().is_empty());
        let linked = checkout();
        fs::create_dir_all(linked.0.join(".pandacode")).unwrap();
        std::os::unix::fs::symlink(&outside.0, linked.0.join(DIR)).unwrap();
        assert!(list(&linked.0).is_err());
        assert!(write(&linked.0, "x", "x").is_err());
    }

    #[test]
    fn comments_round_trip_validate_and_resolve() {
        let t = checkout();
        assert!(comments(&t.0).unwrap().is_empty());
        save_comments(&t.0, &[comment("c1"), comment("c2")]).unwrap();
        let saved = fs::read_to_string(t.0.join(DIR).join(COMMENTS)).unwrap();
        assert!(saved.contains("\"createdAt\": 1") && saved.contains("\"status\": \"open\""));
        let done = resolve(&t.0, "c2", Some("Now 48px".into())).unwrap();
        assert_eq!((done.status, done.note.as_deref()), (Status::Resolved, Some("Now 48px")));
        let all = comments(&t.0).unwrap();
        assert_eq!((all[0].status, all[1].status), (Status::Open, Status::Resolved));
        assert!(resolve(&t.0, "nope", None).is_err());
        let bad = [Comment { artboard: "../x".into(), ..comment("c3") }, Comment { text: " ".into(), ..comment("c4") }, Comment { id: "a/b".into(), ..comment("c5") }, Comment { bbox: Bbox { x: f64::NAN, ..comment("c6").bbox }, ..comment("c6") }];
        for c in bad { assert!(save_comments(&t.0, &[c]).is_err()); }
        assert!(save_comments(&t.0, &vec![comment("c"); MAX_COMMENTS + 1]).is_err());
        assert_eq!(comments(&t.0).unwrap().len(), 2);
    }

    /// Bytes the harness sees: `tools/list` sends name, description and schema.
    fn wire(tools: &[Value]) -> usize {
        tools.iter().map(|t| serde_json::to_string(&json!({"name":t["name"],"description":t["description"],"inputSchema":t["inputSchema"]})).unwrap().len() + 1).sum::<usize>() + 1
    }
    #[test]
    fn the_catalog_fits_its_budget() {
        let bytes = wire(&listed(catalog()));
        println!("design catalog: {bytes} B (was 1799)");
        assert!(bytes <= 1150, "design catalog is {bytes} B");
    }
    #[test]
    fn tool_handlers_validate_and_work_without_a_model() {
        assert_eq!(catalog().len(), 4);
        assert!(validate("pandacode_design_write", &json!({"name":"home","html":"x".repeat(20_000)})).is_ok());
        assert!(validate("pandacode_design_write", &json!({"name":"../home","html":"x"})).is_err());
        assert!(validate("pandacode_design_write", &json!({"name":"home","html":"x","path":"/etc"})).is_err());
        assert!(validate("pandacode_design_comments", &json!({"status":"maybe"})).is_err());
        assert!(validate("pandacode_design_resolve", &json!({})).is_err());
        let t = checkout();
        tool(&t.0, "pandacode_design_write", &json!({"name":"home","html":"<p>x</p>"})).unwrap();
        save_comments(&t.0, &[comment("c1")]).unwrap();
        let listed = tool(&t.0, "pandacode_design_list", &json!({})).unwrap();
        assert_eq!((listed["artboards"][0]["name"].as_str(), listed["openComments"].as_u64()), (Some("home.html"), Some(1)));
        assert_eq!(tool(&t.0, "pandacode_design_comments", &json!({})).unwrap()["comments"][0]["selector"], "body > main > h1");
        tool(&t.0, "pandacode_design_resolve", &json!({"id":"c1","note":"done"})).unwrap();
        assert_eq!(tool(&t.0, "pandacode_design_comments", &json!({})).unwrap()["comments"].as_array().unwrap().len(), 0);
        assert_eq!(tool(&t.0, "pandacode_design_comments", &json!({"status":"resolved"})).unwrap()["comments"][0]["note"], "done");
    }
}
