//! PandaConnect methods for the `design` feature group: the Design canvas's artboards
//! (`.pandacode/design/*.html` in a project's or a task's checkout, `crate::design`) and their
//! comments. See `methods/mod.rs` and docs/remote-access.md, "Adding a method".
//!
//! The phone has no web view, so `design.preview` renders an artboard to a PNG on the computer
//! with QuickLook (macOS only), which runs no scripts, like the desktop's sandboxed iframe. A
//! comment from the phone is a pin on the preview: it names `body` and a small box around the
//! tapped point in the artboard's CSS pixels, which the agent reads like any other comment.
use super::files::{data_page, offset_param, resolve, target_param, text_page, Target};
use super::{allow_task_mode, full_access_off, local_task, text_param, Access, Ctx, Method, Reply, Run};
use crate::design::{self as canvas, Bbox, Comment, Status};
use crate::Result;
use serde_json::{json, Value};
use tauri::Emitter;

/// Text bytes one `design.read` page carries before JSON escaping.
const READ_CHUNK: usize = 96 * 1024;
/// A comment's longest text (the desktop's limit).
const MAX_COMMENT: usize = 4000;
/// The farthest a pin may sit from the artboard's origin, in CSS pixels (the desktop caps artboards at 6000 high).
const MAX_COORD: f64 = 20_000.0;
/// The box a phone pin marks around the tapped point, in CSS pixels.
const PIN: f64 = 24.0;
/// The selector a phone pin names: the phone cannot see the artboard's elements.
const PIN_SELECTOR: &str = "body";
/// Comments one `design.comments` reply carries at most before it is cut to fit.
const MAX_LISTED: usize = 500;

/// `name` as the desktop accepts it (`home` or `home.html`).
fn artboard_param(params: &Value, key: &str) -> Result<String> {
    let name = params.get(key).and_then(Value::as_str).ok_or_else(|| format!("Missing {key}."))?;
    canvas::artboard_name(name)
}

fn optional_artboard(params: &Value) -> Result<Option<String>> {
    match params.get("artboard").filter(|v| !v.is_null()) {
        None => Ok(None),
        Some(_) => artboard_param(params, "artboard").map(Some),
    }
}

/// A finite coordinate within the artboard's bounds.
fn coord_param(params: &Value, key: &str) -> Result<f64> {
    params.get(key).and_then(Value::as_f64).filter(|n| n.is_finite() && (0.0..=MAX_COORD).contains(n)).ok_or_else(|| format!("Invalid {key}."))
}

/// A comment id the desktop wrote (`crypto.randomUUID()`) or the agent tools accept.
fn comment_id_param(params: &Value) -> Result<String> {
    let id = params.get("commentId").and_then(Value::as_str).ok_or("Missing commentId.")?;
    if (1..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(id.to_owned())
    } else {
        Err("Invalid commentId.".into())
    }
}

/// Tells the desktop's canvas to reload, as the agent tools do.
fn changed(ctx: &Ctx<'_>, target: &Target) {
    let payload = match target {
        Target::Task(session_id) => json!({"sessionId": session_id}),
        Target::Project(project_id) => json!({"projectId": project_id}),
    };
    let _ = ctx.app.emit("design-changed", payload);
}

/// The open comments per artboard.
fn open_counts(comments: &[Comment]) -> Value {
    let mut counts = serde_json::Map::new();
    for comment in comments.iter().filter(|c| c.status == Status::Open) {
        let count = counts.get(&comment.artboard).and_then(Value::as_u64).unwrap_or(0) + 1;
        counts.insert(comment.artboard.clone(), json!(count));
    }
    Value::Object(counts)
}

/// Comments on `artboard` (or all), open ones first then newest, cut to fit one reply.
fn listed(comments: Vec<Comment>, artboard: Option<&str>) -> Value {
    let mut kept: Vec<Comment> = comments.into_iter().filter(|c| artboard.is_none_or(|name| c.artboard == name)).collect();
    kept.sort_by(|a, b| (a.status == Status::Resolved).cmp(&(b.status == Status::Resolved)).then(b.created_at.cmp(&a.created_at)));
    let mut truncated = kept.len() > MAX_LISTED;
    kept.truncate(MAX_LISTED);
    while json!({"comments": kept}).to_string().len() > super::PAGE_BUDGET - 1024 && !kept.is_empty() {
        kept.pop();
        truncated = true;
    }
    json!({"comments": kept, "truncated": truncated})
}

/// A pin comment at (`x`, `y`) on `artboard`.
fn pin_comment(artboard: String, x: f64, y: f64, text: String, now: i64) -> Comment {
    let half = PIN / 2.0;
    Comment {
        id: uuid::Uuid::new_v4().to_string(),
        artboard,
        selector: PIN_SELECTOR.into(),
        bbox: Bbox { x: (x - half).max(0.0), y: (y - half).max(0.0), width: PIN, height: PIN },
        text,
        status: Status::Open,
        created_at: now,
        note: None,
    }
}

/// `comments` with `id` set to `status`; an error when there is no such comment.
fn with_status(comments: &[Comment], id: &str, status: Status) -> Result<(Vec<Comment>, Comment)> {
    let found = comments.iter().find(|c| c.id == id).ok_or("That comment is gone. Pull to refresh.")?;
    let changed = Comment { status, ..found.clone() };
    let next = comments.iter().map(|c| if c.id == id { changed.clone() } else { c.clone() }).collect();
    Ok((next, changed))
}

// ---- design.list ----

#[derive(Debug)]
struct List {
    target: Target,
}

impl Run for List {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (_, root) = resolve(&ctx.state(), &self.target).await?;
            crate::blocking(move || {
                let artboards = canvas::list(&root)?;
                // A broken comments file still lists the artboards.
                let open = canvas::comments(&root).map(|c| open_counts(&c)).unwrap_or_else(|_| json!({}));
                let artboards: Vec<Value> = artboards.into_iter().map(|b| json!({"name": b.name, "size": b.size, "modified": b.modified})).collect();
                Ok(json!({"artboards": artboards, "open": open, "preview": preview::AVAILABLE}))
            })
            .await
        })
    }
}

fn parse_list(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(List { target: target_param(params)? }))
}

// ---- design.read ----

#[derive(Debug)]
struct Read {
    target: Target,
    name: String,
    offset: usize,
}

impl Run for Read {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (_, root) = resolve(&ctx.state(), &self.target).await?;
            let (name, offset) = (self.name, self.offset);
            crate::blocking(move || text_page(&canvas::read(&root, &name)?, offset, READ_CHUNK)).await
        })
    }
}

fn parse_read(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Read { target: target_param(params)?, name: artboard_param(params, "name")?, offset: offset_param(params)? }))
}

// ---- design.preview ----

#[derive(Debug)]
struct Preview {
    target: Target,
    name: String,
    offset: usize,
}

impl Run for Preview {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (_, root) = resolve(&ctx.state(), &self.target).await?;
            let (name, offset) = (self.name, self.offset);
            crate::blocking(move || {
                let image = preview::render(&root, &name)?;
                let mut page = data_page("image/png", &image.data, offset)?;
                page["scale"] = json!(preview::SCALE);
                page["key"] = json!(image.key);
                Ok(page)
            })
            .await
        })
    }
}

fn parse_preview(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Preview { target: target_param(params)?, name: artboard_param(params, "name")?, offset: offset_param(params)? }))
}

// ---- design.comments ----

#[derive(Debug)]
struct Comments {
    target: Target,
    artboard: Option<String>,
}

impl Run for Comments {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (_, root) = resolve(&ctx.state(), &self.target).await?;
            let artboard = self.artboard;
            crate::blocking(move || Ok(listed(canvas::comments(&root)?, artboard.as_deref()))).await
        })
    }
}

fn parse_comments(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Comments { target: target_param(params)?, artboard: optional_artboard(params)? }))
}

// ---- design.comment ----

#[derive(Debug)]
struct AddComment {
    target: Target,
    artboard: String,
    x: f64,
    y: f64,
    text: String,
}

/// A pin's text is read by agents working on the canvas, so with the switch off it may not
/// reach a task in `full` mode: the task's own, and whenever the pin lands in the project's
/// checkout (a project target, or a task with no worktree of its own) any full-mode task
/// working in that checkout.
async fn allow_comment(ctx: &Ctx<'_>, target: &Target) -> Result<()> {
    if ctx.full_access {
        return Ok(());
    }
    let project_id = match target {
        Target::Task(session_id) => {
            let task = local_task(&ctx.state(), session_id).await?;
            allow_task_mode(&task.mode, None, false)?;
            if task.worktree_path.is_some() {
                return Ok(());
            }
            task.project_id
        }
        Target::Project(project_id) => project_id.clone(),
    };
    let store = ctx.state().store.clone();
    let sessions = crate::blocking(move || store.lock().map_err(|e| e.to_string())?.sessions()).await?;
    shared_checkout_allows(checkout_modes(&sessions, &project_id))
}

/// The modes of the tasks working in `project_id`'s own checkout (no worktree of their own).
fn checkout_modes<'a>(sessions: &'a [crate::storage::Session], project_id: &'a str) -> impl Iterator<Item = &'a str> {
    sessions.iter().filter(move |s| s.project_id == project_id && s.worktree_path.is_none()).map(|s| s.mode.as_str())
}

/// Whether the switch-off comment may land in a checkout shared by tasks with these modes.
fn shared_checkout_allows<'a>(mut modes: impl Iterator<Item = &'a str>) -> Result<()> {
    if modes.any(|mode| mode == "full") {
        return Err(full_access_off());
    }
    Ok(())
}

impl Run for AddComment {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            allow_comment(&ctx, &self.target).await?;
            let (_, root) = resolve(&ctx.state(), &self.target).await?;
            let AddComment { target, artboard, x, y, text } = *self;
            let comment = crate::blocking(move || {
                // Only on an artboard that exists, as on the desktop.
                if !canvas::list(&root)?.iter().any(|b| b.name == artboard) {
                    return Err(format!("No artboard named {artboard}."));
                }
                let comment = pin_comment(artboard, x, y, text, crate::storage::now());
                let mut next = canvas::comments(&root)?;
                next.push(comment.clone());
                canvas::save_comments(&root, &next)?;
                Ok(comment)
            })
            .await?;
            changed(&ctx, &target);
            Ok(json!({"comment": comment}))
        })
    }
}

fn parse_comment(params: &Value) -> Result<Box<dyn Run>> {
    let text = text_param(params, "text")?;
    if text.len() > MAX_COMMENT {
        return Err(format!("Comments are limited to {MAX_COMMENT} characters."));
    }
    Ok(Box::new(AddComment { target: target_param(params)?, artboard: artboard_param(params, "artboard")?, x: coord_param(params, "x")?, y: coord_param(params, "y")?, text }))
}

// ---- design.resolve ----

#[derive(Debug)]
struct Resolve {
    target: Target,
    comment_id: String,
    status: Status,
}

impl Run for Resolve {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (_, root) = resolve(&ctx.state(), &self.target).await?;
            let Resolve { target, comment_id, status } = *self;
            let comment = crate::blocking(move || {
                let (next, comment) = with_status(&canvas::comments(&root)?, &comment_id, status)?;
                canvas::save_comments(&root, &next)?;
                Ok(comment)
            })
            .await?;
            changed(&ctx, &target);
            Ok(json!({"comment": comment}))
        })
    }
}

fn parse_resolve(params: &Value) -> Result<Box<dyn Run>> {
    let status = match params.get("status").filter(|v| !v.is_null()).map(Value::as_str) {
        None | Some(Some("resolved")) => Status::Resolved,
        Some(Some("open")) => Status::Open,
        Some(_) => return Err("Invalid status.".into()),
    };
    Ok(Box::new(Resolve { target: target_param(params)?, comment_id: comment_id_param(params)?, status }))
}

pub(crate) const METHODS: &[Method] = &[
    Method { name: "design.list", access: Access::View, read_only: true, parse: parse_list },
    Method { name: "design.read", access: Access::View, read_only: true, parse: parse_read },
    Method { name: "design.preview", access: Access::View, read_only: true, parse: parse_preview },
    Method { name: "design.comments", access: Access::View, read_only: true, parse: parse_comments },
    Method { name: "design.comment", access: Access::Control, read_only: false, parse: parse_comment },
    Method { name: "design.resolve", access: Access::Control, read_only: false, parse: parse_resolve },
];

/// What QuickLook may load while rendering an artboard: nothing but inline styles and
/// `data:` images. `sanitize_artboard` puts it first in the document, where no markup the
/// artboard holds (an open comment, a stray `<head>`) can hide it.
const PREVIEW_CSP: &str = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";
/// Sanitizer passes before a preview is refused. A pass only removes text, so a document
/// that still changes after this many was built to reassemble what a pass took out.
const SANITIZE_PASSES: usize = 8;
/// Attributes that only ever hold text, so a character reference in them is harmless.
const TEXT_ATTRS: &[&str] = &["alt", "title", "placeholder", "value"];
/// URL-bearing attributes (matched on the name after any `prefix:`).
const URL_ATTRS: &[&str] = &["src", "href", "srcset", "poster", "data", "action", "formaction", "background", "ping", "manifest", "codebase", "archive", "longdesc", "usemap", "lowsrc", "dynsrc"];

fn pattern(source: &str) -> regex::Regex {
    regex::Regex::new(source).expect("preview sanitizer pattern")
}

/// HTML comments, including an unterminated one (which runs to the end).
static HTML_COMMENT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| pattern(r"(?s)<!--.*?(?:--!?>|\z)"));
static DOCTYPE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| pattern(r"(?i)<!doctype[^>]*>"));
/// Scripts with their bodies (QuickLook does not run them; they go anyway).
static SCRIPT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| pattern(r"(?is)<script\b.*?(?:</script\s*>|\z)"));
/// Elements that load or embed other documents, change the base URL, or (`meta`) set
/// policies and redirects: their opening and closing tags are dropped.
static BLOCKED_TAG: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| pattern(r"(?i)</?(?:link|script|iframe|frame|frameset|object|embed|applet|base|meta|portal|animatetransform|animatemotion|animate|set)\b[^>]*>"));
/// `<style>` elements (raw text in HTML, but entity-decoded inside SVG).
static STYLE_BLOCK: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| pattern(r"(?is)<style\b[^>]*>.*?(?:</style\s*>|\z)"));
/// A character reference, named or numeric, with or without its `;`.
static CHAR_REF: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| pattern(r"&[#a-zA-Z]"));
/// CSS `url(...)`, quoted or bare.
static CSS_URL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| pattern(r#"(?i)url\(\s*("[^"]*"|'[^']*'|[^)]*?)\s*\)"#));
/// CSS `@import` rules, which can name a URL without `url(...)`.
static CSS_IMPORT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| pattern(r"(?i)@import\b[^;<]*;?"));
/// CSS functions that take a bare string as a URL (`image-set("a.png" 1x)`, `src("a")`).
static CSS_LOADER: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| pattern(r"(?i)\b(?:image-set|image|cross-fade|element|src)\("));
/// Any attribute with a value: name, `=` and the value as written.
static ATTR: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| pattern(r#"([^\s"'<>/=]+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)"#));

/// A URL attribute assignment anywhere in the text (`xlink:href=`, `src =` ...), whatever
/// markup surrounds it: the name, `=` and the value as written.
static URL_ASSIGN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    pattern(&format!(r#"(?i)((?:[a-z0-9_.-]+:)?(?:{}))(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)"#, URL_ATTRS.join("|")))
});

/// A URL an artboard preview may keep: inline `data:` and in-page `#` references. Anything
/// else (http(s), `//`, `file:`, absolute or relative paths, entity-encoded tricks) is dropped.
fn safe_preview_url(raw: &str) -> bool {
    let value = raw.trim().trim_matches(|c| c == '"' || c == '\'').trim();
    value.is_empty() || value.starts_with('#') || value.get(..5).is_some_and(|scheme| scheme.eq_ignore_ascii_case("data:"))
}

/// One attribute as a preview keeps it: a value with a character reference is emptied
/// (it could decode to `url(`, a CSS escape or a scheme) unless the attribute only holds
/// text, and URL attributes keep only `data:` and `#` values (`srcset` never).
fn sanitize_attr(caps: &regex::Captures) -> String {
    let name = caps[1].to_ascii_lowercase();
    let local = name.rsplit(':').next().unwrap_or(&name);
    let value = &caps[3];
    let text_only = TEXT_ATTRS.contains(&name.as_str()) || name.starts_with("aria-");
    let encoded = CHAR_REF.is_match(value) && !text_only;
    let unsafe_url = URL_ATTRS.contains(&local) && (local == "srcset" || !safe_preview_url(value));
    if encoded || unsafe_url {
        format!("{}{}\"\"", &caps[1], &caps[2])
    } else {
        caps[0].to_owned()
    }
}

/// Empties every URL attribute value that is not `data:` or `#`, wherever it sits: inside
/// another attribute's quotes, in text, anywhere. [`ATTR`] reads quotes from raw text, so
/// `<p>x="<img src=http://…>"</p>` hides a live `<img src>` from it; this pass does not
/// depend on quote parsing. Each match is checked one character on, so a value (even a
/// kept `data:` one) cannot hide an assignment inside it.
fn neutralise_urls(html: &str) -> String {
    let name_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':');
    let mut out = String::with_capacity(html.len());
    let (mut copied, mut from) = (0, 0);
    while let Some(caps) = URL_ASSIGN.captures_at(html, from) {
        let whole = caps.get(0).expect("match");
        let starts_name = !html[..whole.start()].chars().next_back().is_some_and(name_char);
        if starts_name && !safe_preview_url(&caps[3]) {
            out.push_str(&html[copied..whole.start()]);
            out.push_str(&caps[1]);
            out.push_str(&caps[2]);
            out.push_str("\"\"");
            copied = whole.end();
            from = whole.end();
        } else {
            from = whole.start() + html[whole.start()..].chars().next().map_or(1, char::len_utf8);
        }
    }
    out.push_str(&html[copied..]);
    out
}

/// One sanitizer pass. Removals come before the URL filters, so text a removal joins
/// (`u<!---->rl(`, `u\rl(`) is still filtered; `sanitize_artboard` repeats until stable.
fn sanitize_pass(html: &str) -> String {
    let html = HTML_COMMENT.replace_all(html, "");
    let html = DOCTYPE.replace_all(&html, "");
    let html = SCRIPT.replace_all(&html, "");
    let html = BLOCKED_TAG.replace_all(&html, "");
    // CSS escapes (`\75rl(`) can spell anything, so backslashes go (artboard text included).
    let html = html.replace('\\', "");
    let html = STYLE_BLOCK.replace_all(&html, |caps: &regex::Captures| if CHAR_REF.is_match(&caps[0]) { String::new() } else { caps[0].to_owned() });
    let html = CSS_IMPORT.replace_all(&html, "");
    let html = CSS_URL.replace_all(&html, |caps: &regex::Captures| if safe_preview_url(&caps[1]) { caps[0].to_owned() } else { "none".to_owned() });
    let html = CSS_LOADER.replace_all(&html, "none(");
    let html = ATTR.replace_all(&html, sanitize_attr);
    neutralise_urls(&html)
}

/// The artboard as QuickLook may render it: comments, scripts, embeds, `<base>`, `<meta>`,
/// backslashes and encoded attribute values removed; external, `file:` and path references
/// dropped from URL attributes and CSS; and the CSP as the document's first element.
///
/// This is the whole defence: `qlmanage` cannot run under `sandbox-exec` (it sets up its own
/// sandbox, which fails inside one) and renders in QuickLook's own services anyway.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn sanitize_artboard(html: &str) -> Result<String> {
    let mut current = html.to_owned();
    for _ in 0..SANITIZE_PASSES {
        let next = sanitize_pass(&current);
        if next == current {
            return Ok(format!("<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"{PREVIEW_CSP}\">{current}"));
        }
        current = next;
    }
    Err("This artboard can't be previewed.".into())
}

/// Artboard previews: a QuickLook thumbnail of the artboard's top, cached per file version so
/// every page of one preview comes from the same render.
mod preview {
    use crate::Result;
    use std::path::Path;

    /// Whether this computer can render previews.
    pub(super) const AVAILABLE: bool = cfg!(target_os = "macos");
    /// The preview's width in pixels; QuickLook renders a 1024-pixel-wide page into it.
    #[cfg(target_os = "macos")]
    const SIZE: u32 = 1280;
    /// Preview pixels per CSS pixel (1280 / QuickLook's 1024-pixel viewport).
    pub(super) const SCALE: f64 = 1.25;

    pub(super) struct Image {
        /// Base64 PNG.
        pub(super) data: String,
        /// The file version it shows, so a viewer can tell two renders apart.
        pub(super) key: String,
    }

    #[cfg(target_os = "macos")]
    mod cache {
        use std::sync::Mutex;
        /// The last few renders: (file version, base64 PNG).
        pub(super) static RENDERS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
        pub(super) const KEEP: usize = 4;
    }

    /// The artboard's version: its path, size and modified time.
    fn version(root: &Path, name: &str) -> Result<String> {
        let board = crate::design::list(root)?.into_iter().find(|b| b.name == name).ok_or_else(|| format!("No artboard named {name}."))?;
        let root = root.canonicalize().map_err(|_| "Checkout is unavailable.")?;
        Ok(format!("{}\u{0}{}\u{0}{}\u{0}{}", root.display(), board.name, board.size, board.modified))
    }

    /// A short key for `version` (no paths reach the phone).
    fn key_of(version: &str) -> String {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        version.hash(&mut hasher);
        format!("{:016x}", hasher.finish())
    }

    #[cfg(target_os = "macos")]
    pub(super) fn render(root: &Path, name: &str) -> Result<Image> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        use std::time::Duration;
        let version = version(root, name)?;
        let key = key_of(&version);
        if let Some((_, data)) = cache::RENDERS.lock().map_err(|e| e.to_string())?.iter().find(|(v, _)| *v == version) {
            return Ok(Image { data: data.clone(), key });
        }
        // `read` checks the file is a regular, bounded artboard inside the checkout.
        let html = super::sanitize_artboard(&crate::design::read(root, name)?)?;
        let dir = std::env::temp_dir().join(format!("pandacode-design-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
        let rendered = (|| {
            let source = dir.join("artboard.html");
            std::fs::write(&source, html).map_err(|e| e.to_string())?;
            let mut command = std::process::Command::new("/usr/bin/qlmanage");
            command.arg("-t").arg("-s").arg(SIZE.to_string()).arg("-o").arg(&dir).arg(&source);
            crate::workspace::checked(crate::workspace::run_process(command, "QuickLook", 64 * 1024, Duration::from_secs(20))?)?;
            let png = std::fs::read(dir.join("artboard.html.png")).map_err(|_| "Could not render a preview of this artboard.".to_string())?;
            Ok::<_, String>(STANDARD.encode(png))
        })();
        let _ = std::fs::remove_dir_all(&dir);
        let data = rendered?;
        let mut renders = cache::RENDERS.lock().map_err(|e| e.to_string())?;
        renders.retain(|(v, _)| *v != version);
        renders.push((version, data.clone()));
        let excess = renders.len().saturating_sub(cache::KEEP);
        renders.drain(..excess);
        Ok(Image { data, key })
    }

    #[cfg(not(target_os = "macos"))]
    pub(super) fn render(root: &Path, name: &str) -> Result<Image> {
        let _ = key_of(&version(root, name)?);
        Err("Artboard previews need PandaCode on a Mac.".into())
    }

    #[cfg(test)]
    pub(super) fn key(version: &str) -> String {
        key_of(version)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smil_animation_tags_are_removed() {
        let html = r##"<svg><a><set attributeName="href" to="https://x.test/"/><animate attributeName="href" values="javascript:alert(1)"/><animateMotion dur="1s"></animateMotion><ANIMATETRANSFORM attributeName="transform"/><text>keep</text><settings>kept</settings></a></svg>"##;
        let out = sanitize_artboard(html).unwrap();
        for tag in ["<set ", "<animate", "<ANIMATE", "</animateMotion"] {
            assert!(!out.contains(tag), "{tag} in {out}");
        }
        assert!(out.contains("<text>keep</text>") && out.contains("<settings>"), "{out}");
    }

    #[test]
    fn comments_need_the_switch_for_full_mode_tasks() {
        assert!(shared_checkout_allows(["ask", "auto"].into_iter()).is_ok());
        assert!(shared_checkout_allows(std::iter::empty()).is_ok());
        assert!(shared_checkout_allows(["ask", "full"].into_iter()).unwrap_err().starts_with("Full access is off for remote tasks on "));
        // A task without a worktree shares the project's checkout with every other such task.
        let store = crate::storage::Store::open(std::path::Path::new(":memory:")).unwrap();
        let base = std::env::temp_dir().join(format!("pandacode-design-modes-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let project = store.add_project(&base).unwrap();
        let ask = store.create_session(&project.id, "codex", "m", "ask").unwrap();
        store.create_session(&project.id, "codex", "m", "full").unwrap();
        let sessions = store.sessions().unwrap();
        assert!(sessions.iter().any(|s| s.id == ask.id && s.worktree_path.is_none()));
        assert!(shared_checkout_allows(checkout_modes(&sessions, &project.id)).is_err(), "an ask task's pin reaches the full task beside it");
        assert!(shared_checkout_allows(checkout_modes(&sessions, "elsewhere")).is_ok());
        let _ = std::fs::remove_dir_all(base);
        let source = include_str!("design.rs");
        let gate = &source[source.find("async fn allow_comment").unwrap()..];
        let gate = &gate[..gate.find("\n}\n").unwrap()];
        assert!(gate.find("task.worktree_path.is_some()").unwrap() < gate.find("shared_checkout_allows(").unwrap(), "task targets check the shared checkout too");
        let body = &source[source.find("impl Run for AddComment").unwrap()..];
        assert!(body.find("allow_comment(&ctx, &self.target)").unwrap() < body.find("save_comments").unwrap(), "checked before the write");
    }

    #[test]
    fn artboard_previews_load_nothing_from_outside() {
        let html = r##"<!doctype html><html><head><title>A</title><style>@import url("https://x.test/a.css"); @import 'file:///etc/x.css'; body{background:url(https://x.test/bg.png)} .a{background:url( '/Users/me/secret.png' )} .b{background:url(data:image/png;base64,AAA)}</style><meta http-equiv="refresh" content="0;url=https://x.test/"><base href="//x.test/"></head>
<body><img src="https://x.test/p.png"><img/src='file:///etc/passwd'><img src=/abs/path.png><img src="../../../Users/me/a.png"><img srcset="https://x.test/1.png 1x, data:image/png;base64,AA 2x"><a href="#top">top</a><img src="data:image/png;base64,QUJD" data-src="https://x.test/keep-attr-name">
<svg><image xlink:href="http://x.test/s.svg"/></svg><div style="background-image:url(&quot;http://x.test/q&quot;)"></div><img SRC = " &#104;ttp://x.test/e.png"></body></html>"##;
        let out = sanitize_artboard(html).unwrap();
        for leaked in ["https://x.test/a.css", "file:///etc", "https://x.test/bg.png", "/Users/me/secret.png", "x.test/p.png", "/abs/path.png", "../../../Users", "x.test/1.png", "http-equiv=\"refresh", "//x.test/\"", "x.test/s.svg", "x.test/q", "&#104;ttp", "@import", "<base"] {
            assert!(!out.contains(leaked), "{leaked} survived: {out}");
        }
        assert!(out.contains("url(data:image/png;base64,AAA)"));
        assert!(out.contains(r##"href="#top""##));
        assert!(out.contains(r#"src="data:image/png;base64,QUJD""#));
        assert!(out.contains("data-src="), "data-* attributes are not URL attributes");
        assert!(out.contains("<title>A</title>"));
        assert_eq!(PREVIEW_CSP, "default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    }

    /// The CSP is the document's first element, ahead of anything the artboard wrote.
    fn csp_first(out: &str) -> bool {
        out.starts_with(&format!("<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"{PREVIEW_CSP}\">")) && out.matches("<meta").count() == 1 && out.matches("<!doctype").count() == 1
    }

    #[test]
    fn every_artboard_gets_the_csp_first() {
        for html in ["<div>hi</div>", "<html lang=en><p>x</p>", "<!DOCTYPE html><html><head></head><body></body></html>", "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src *\"><p>x"] {
            let out = sanitize_artboard(html).unwrap();
            assert!(csp_first(&out), "{out}");
        }
        assert!(safe_preview_url(" DATA:image/png;base64,AA") && safe_preview_url("'#a'") && !safe_preview_url("//x") && !safe_preview_url("C:\\x"));
    }

    #[test]
    fn a_head_inside_a_comment_cannot_hide_the_csp() {
        // The confirmed bypass: the old sanitizer put the CSP after the first `<head` match,
        // which here sat inside a comment.
        let out = sanitize_artboard("<!--<head>--><html><head></head><body><div style=\"background:url(file:///Users/me/secret.png)\"></div><img src=\"http://x.test/a\"></body></html>").unwrap();
        assert!(csp_first(&out), "{out}");
        assert!(!out.contains("<!--") && !out.contains("file:") && !out.contains("x.test"), "{out}");
        // An unterminated comment swallows the rest rather than hiding anything.
        assert!(csp_first(&sanitize_artboard("<p>a</p><!-- <img src=http://x.test/>").unwrap()));
    }

    #[test]
    fn css_escapes_and_encodings_cannot_spell_a_url() {
        let attacks = [
            // The confirmed bypass: a CSS escape for `u`.
            r#"<div style="background:\75rl(file:///Users/me/secret.png)"></div>"#,
            r#"<style>.a{background:\75 rl('file:///Users/me/secret.png')}</style>"#,
            r#"<style>.a{background:u\rl(file:///Users/me/secret.png)}</style>"#,
            r#"<style>@\69mport 'http://x.test/a.css';</style>"#,
            // An entity decoding to `\` or `u` in an attribute, or in SVG's decoded <style>.
            r#"<div style="background:&#92;75rl(file:///Users/me/secret.png)"></div>"#,
            r#"<div style="background:&#117;rl(file:///Users/me/secret.png)"></div>"#,
            r#"<svg><rect fill="&#x75;rl(file:///Users/me/secret.png)"/></svg>"#,
            r#"<svg><style>rect{fill:&#117;rl(file:///Users/me/secret.png)}</style></svg>"#,
            // Removed markup joining the pieces back together.
            r#"<div style="background:u<!---->rl(file:///Users/me/secret.png)"></div>"#,
            r#"<style>.a{background:u<link>rl(file:///Users/me/secret.png)}</style>"#,
            // URL-taking functions without `url(`.
            r#"<div style="background:image-set('file:///Users/me/secret.png' 1x)"></div>"#,
            r#"<div style="background:-webkit-image-set('file:///Users/me/secret.png' 1x)"></div>"#,
        ];
        for attack in attacks {
            let out = sanitize_artboard(attack).unwrap();
            assert!(csp_first(&out), "{out}");
            // What is left of a URL is inert text: nothing can load it.
            let lower = out.to_ascii_lowercase();
            for loader in ["\\", "&#", "url(", "image-set(", "@import"] {
                assert!(!lower.contains(loader), "{loader} survived {attack}: {out}");
            }
        }
        // A URL attribute hidden in another attribute's quotes, where `ATTR` cannot see it.
        for attack in [
            r#"<p>x="<img src=http://x.test/a>"</p>"#,
            r#"<p>x='<img src="http://x.test/a">'</p>"#,
            r#"<p title="<img SRC = //x.test/a>">t</p>"#,
            r#"<p>x="<svg><image xlink:href=http://x.test/a /></svg>"</p>"#,
            r#"<img src="data:image/png;base64,AA"src=http://x.test/a>"#,
            r#"<a href="data:text/html,<img src=http://x.test/a>">a</a>"#,
            "<p>a=\"<video poster=file:///etc/x srcset=a.png background=b.png formaction=c action=d data=e>\"</p>",
        ] {
            let out = sanitize_artboard(attack).unwrap();
            for url in ["x.test", "file:", "a.png", "b.png", "=c", "=d", "=e"] {
                assert!(!out.contains(url), "{url} survived {attack}: {out}");
            }
        }
        assert_eq!(neutralise_urls(r##"<img src="data:image/png;base64,AA"><a href="#top" data-src=x.png>"##), r##"<img src="data:image/png;base64,AA"><a href="#top" data-src=x.png>"##);
        assert_eq!(neutralise_urls("<p>x=\"<img src=http://x.test/a>\"</p>"), "<p>x=\"<img src=\"\">\"</p>");
        // Text attributes may keep their entities.
        assert!(sanitize_artboard(r#"<img alt="Tom &amp; Jerry" src="data:image/png;base64,AA">"#).unwrap().contains("Tom &amp; Jerry"));
    }

    #[test]
    fn embeds_scripts_and_base_are_stripped() {
        let out = sanitize_artboard(r#"<head><base href="http://x.test/"><link rel=stylesheet href=a.css><script>fetch('http://x.test')</script></head><body><iframe src="data:text/html,x"></iframe><object data="data:text/html,x"></object><embed src="data:,x"><SCRIPT src=data:,x></SCRIPT><p>kept</p></body>"#).unwrap();
        for tag in ["<base", "<link", "<script", "<SCRIPT", "<iframe", "<object", "<embed", "fetch("] {
            assert!(!out.contains(tag), "{tag} survived: {out}");
        }
        assert!(out.contains("<p>kept</p>"));
    }

    fn parsed(name: &str, params: Value) -> Result<String> {
        super::super::parse(name, &params).expect("registered").map(|p| format!("{:?}", p.call))
    }

    #[test]
    fn methods_have_the_right_access() {
        for (name, access, read_only) in [
            ("design.list", Access::View, true),
            ("design.read", Access::View, true),
            ("design.preview", Access::View, true),
            ("design.comments", Access::View, true),
            ("design.comment", Access::Control, false),
            ("design.resolve", Access::Control, false),
        ] {
            let method = super::super::find(name).unwrap();
            assert_eq!((method.access, method.read_only), (access, read_only), "{name}");
        }
    }

    #[test]
    fn targets_and_artboard_names_are_validated() {
        assert!(parsed("design.list", json!({})).unwrap_err().contains("Choose a project"));
        assert!(parsed("design.list", json!({"projectId": "p1"})).is_ok());
        assert!(parsed("design.list", json!({"projectId": "a b"})).is_err());
        assert!(parsed("design.read", json!({"projectId": "p1", "name": "home"})).unwrap().contains("home.html"));
        for bad in ["../secrets", ".hidden", "a/b", "", "x".repeat(70).as_str()] {
            assert!(parsed("design.read", json!({"projectId": "p1", "name": bad})).is_err(), "{bad}");
            assert!(parsed("design.preview", json!({"projectId": "p1", "name": bad})).is_err(), "{bad}");
        }
        assert!(parsed("design.read", json!({"projectId": "p1", "name": "home.html", "offset": -1})).is_err());
        assert!(parsed("design.comments", json!({"sessionId": "s1", "artboard": "../x"})).is_err());
        assert!(parsed("design.comments", json!({"sessionId": "s1", "artboard": null})).is_ok());
    }

    #[test]
    fn new_comments_are_bounded_pins() {
        let ok = json!({"projectId": "p1", "artboard": "home", "x": 10.5, "y": 20, "text": "Bigger title"});
        assert!(parsed("design.comment", ok.clone()).is_ok());
        for (key, bad) in [("x", json!(-1)), ("y", json!(1e9)), ("x", json!("3")), ("text", json!("  ")), ("text", json!("a".repeat(4001))), ("artboard", json!("a/b"))] {
            let mut params = ok.clone();
            params[key] = bad;
            assert!(parsed("design.comment", params).is_err(), "{key}");
        }
        let pin = pin_comment("home.html".into(), 5.0, 100.0, "Hi".into(), 7);
        assert_eq!(pin.selector, "body");
        assert_eq!((pin.bbox.x, pin.bbox.y, pin.bbox.width), (0.0, 88.0, PIN));
        assert_eq!((pin.status, pin.created_at), (Status::Open, 7));
        assert!(pin.id.len() <= 64 && pin.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    }

    #[test]
    fn resolve_takes_a_comment_id_and_a_status() {
        assert!(parsed("design.resolve", json!({"projectId": "p1", "commentId": "abc-1"})).unwrap().contains("Resolved"));
        assert!(parsed("design.resolve", json!({"projectId": "p1", "commentId": "abc-1", "status": "open"})).unwrap().contains("Open"));
        assert!(parsed("design.resolve", json!({"projectId": "p1", "commentId": "abc-1", "status": "done"})).is_err());
        assert!(parsed("design.resolve", json!({"projectId": "p1", "commentId": "a b"})).is_err());
        assert!(parsed("design.resolve", json!({"projectId": "p1"})).is_err());
    }

    fn comment(id: &str, artboard: &str, status: Status, at: i64) -> Comment {
        Comment { status, created_at: at, id: id.into(), ..pin_comment(artboard.into(), 0.0, 0.0, "t".into(), 0) }
    }

    #[test]
    fn comments_list_open_first_newest_first_and_count_per_artboard() {
        let all = vec![comment("a", "home.html", Status::Resolved, 3), comment("b", "home.html", Status::Open, 1), comment("c", "home.html", Status::Open, 2), comment("d", "about.html", Status::Open, 9)];
        let reply = listed(all.clone(), Some("home.html"));
        let ids: Vec<&str> = reply["comments"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["c", "b", "a"]);
        assert_eq!(reply["truncated"], false);
        assert_eq!(listed(all.clone(), None)["comments"].as_array().unwrap().len(), 4);
        assert_eq!(open_counts(&all), json!({"home.html": 2, "about.html": 1}));
        let (next, changed) = with_status(&all, "a", Status::Open).unwrap();
        assert_eq!(changed.status, Status::Open);
        assert_eq!(next.iter().filter(|c| c.status == Status::Open).count(), 4);
        assert!(with_status(&all, "zz", Status::Open).is_err());
    }

    #[test]
    fn comments_end_to_end_in_a_checkout() {
        let dir = std::env::temp_dir().join(format!("pandacode-design-methods-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        canvas::write(&dir, "home", "<h1>Hi</h1>").unwrap();
        assert_eq!(canvas::list(&dir).unwrap().len(), 1);
        let pin = pin_comment("home.html".into(), 40.0, 40.0, "Bigger".into(), 1);
        canvas::save_comments(&dir, std::slice::from_ref(&pin)).unwrap();
        let (next, _) = with_status(&canvas::comments(&dir).unwrap(), &pin.id, Status::Resolved).unwrap();
        canvas::save_comments(&dir, &next).unwrap();
        assert_eq!(canvas::comments(&dir).unwrap()[0].status, Status::Resolved);
        assert_eq!(preview::key("a").len(), 16);
        assert_ne!(preview::key("a"), preview::key("b"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
