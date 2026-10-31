//! Visual progress: agents post one annotated screenshot (or an SVG idea sketch)
//! per iteration of a GUI they are building. Snapshots live in app data under
//! `progress/<session>/`, never in the checkout; images are copied in so later
//! edits to the workspace file never change history.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, ImageFormat, ImageReader, Limits};
use tauri::{Emitter, Manager};

use crate::{agent_tools::spec, providers::ToolHost, AppState};

type Result<T> = std::result::Result<T, String>;

pub const DIR: &str = "progress";
const INDEX: &str = "index.json";
const TOOL: &str = "pandacode_progress_snapshot";
const EVENT: &str = "progress-changed";
const MAX_SNAPSHOTS: usize = 200;
const MAX_IMAGE: u64 = 8 * 1024 * 1024;
const MAX_SVG: usize = 64 * 1024;
const MAX_TITLE: usize = 120;
const MAX_NOTE: usize = 1000;
const MAX_LABEL: usize = 160;
const MAX_ANNOTATIONS: usize = 24;
const MAX_INDEX: u64 = 4 * 1024 * 1024;
const MEDIA_EXTENSIONS: [&str; 5] = ["png", "jpg", "webp", "gif", "svg"];
const THUMB_EXTENSIONS: [&str; 2] = ["thumb.jpg", "thumb.png"];
const THUMB_WIDTH: u32 = 320;
/// All media one task keeps, thumbnails included.
const MAX_SESSION_BYTES: u64 = 256 * 1024 * 1024;
/// Decoding limits for thumbnails, far above any real screenshot.
const MAX_DECODE_SIDE: u32 = 16_384;
const MAX_DECODE_ALLOC: u64 = 256 * 1024 * 1024;
/// ponytail: one lock for every session's index; per-session locks if snapshots ever contend.
static WRITE: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Shape { Box, Circle, Arrow, Pin, Highlight }

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Tone { #[default] Accent, Info, Success, Warning, Danger }

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind { Image, Idea }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Annotation {
    #[serde(rename = "type")]
    pub shape: Shape,
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub w: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub h: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x2: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y2: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default)]
    pub tone: Tone,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub iteration: u32,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub kind: Kind,
    pub annotations: Vec<Annotation>,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

/// What the agent posted, validated; `image` is still a workspace path.
#[derive(Debug, Clone, PartialEq)]
pub struct Draft {
    pub title: String,
    pub note: Option<String>,
    pub annotations: Vec<Annotation>,
    pub source: Source,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Source { Image(String), Svg(String) }

/// Media ready to store: bytes and the extension they are saved under.
pub enum Media { Image(Vec<u8>, &'static str), Svg(String) }

fn in_unit(n: f64) -> bool { n.is_finite() && (0.0..=1.0).contains(&n) }

fn check_annotation(a: &Annotation, index: usize) -> Result<()> {
    let bad = |why: &str| Err(format!("Annotation {} {why}.", index + 1));
    let numbers = [Some(a.x), Some(a.y), a.w, a.h, a.x2, a.y2];
    if !numbers.iter().flatten().all(|n| in_unit(*n)) { return bad("needs numbers from 0 to 1"); }
    match a.shape {
        Shape::Box | Shape::Circle | Shape::Highlight if a.w.is_none() || a.h.is_none() => return bad("needs w and h"),
        Shape::Arrow if a.x2.is_none() || a.y2.is_none() => return bad("needs x2 and y2"),
        _ => {}
    }
    if a.label.as_ref().is_some_and(|l| l.chars().count() > MAX_LABEL) { return bad(&format!("label is longer than {MAX_LABEL} characters")); }
    Ok(())
}

/// Validates the tool arguments; `validate_spec` caps strings at 8 KiB, too small for `svg`.
pub fn parse(args: &Value) -> Result<Draft> {
    let object = args.as_object().ok_or("Tool arguments must be an object.")?;
    if let Some(key) = object.keys().find(|k| !matches!(k.as_str(), "title" | "note" | "image" | "svg" | "annotations")) {
        return Err(format!("Unknown argument: {key}"));
    }
    let text = |key: &str| -> Result<Option<String>> {
        match object.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.trim().to_owned()).filter(|s| !s.is_empty())),
            Some(_) => Err(format!("{key} must be a string.")),
        }
    };
    let title = text("title")?.ok_or("title is required.")?;
    if title.chars().count() > MAX_TITLE { return Err(format!("title is limited to {MAX_TITLE} characters.")); }
    let note = text("note")?;
    if note.as_ref().is_some_and(|n| n.chars().count() > MAX_NOTE) { return Err(format!("note is limited to {MAX_NOTE} characters.")); }
    let source = match (text("image")?, text("svg")?) {
        (Some(path), None) => Source::Image(path),
        (None, Some(svg)) => {
            if svg.len() > MAX_SVG { return Err(format!("svg is limited to {} KiB.", MAX_SVG / 1024)); }
            if svg.contains('\0') || !svg_body(&svg).starts_with("<svg") { return Err("svg must be an SVG document starting with <svg (an <?xml?> prolog or <!DOCTYPE> may come first).".into()); }
            Source::Svg(svg)
        }
        _ => return Err("Give exactly one of image (a screenshot path) or svg (an idea sketch).".into()),
    };
    let annotations: Vec<Annotation> = match object.get("annotations") {
        None | Some(Value::Null) => Vec::new(),
        Some(value) => serde_json::from_value(value.clone()).map_err(|e| format!("annotations are not valid: {e}"))?,
    };
    if annotations.len() > MAX_ANNOTATIONS { return Err(format!("At most {MAX_ANNOTATIONS} annotations.")); }
    annotations.iter().enumerate().try_for_each(|(i, a)| check_annotation(a, i))?;
    Ok(Draft { title, note, annotations, source })
}

/// The SVG after an optional `<?xml …?>` prolog and `<!DOCTYPE …>`.
fn svg_body(svg: &str) -> &str {
    let mut rest = svg.trim_start();
    for (open, close) in [("<?xml", "?>"), ("<!DOCTYPE", ">")] {
        if let Some(end) = rest.strip_prefix(open).and_then(|after| after.find(close)) {
            rest = rest[open.len() + end + close.len()..].trim_start();
        }
    }
    rest
}

/// Best-effort pixel size from the root tag's width/height, else its viewBox.
fn svg_size(svg: &str) -> Option<(u32, u32)> {
    let body = svg_body(svg);
    let tag = &body[..body.find('>')?];
    let attr = |name: &str| {
        let at = tag.find(&format!(" {name}=\""))? + name.len() + 3;
        tag[at..].split('"').next()
    };
    let number = |n: f64| (n.is_finite() && (1.0..=100_000.0).contains(&n)).then(|| n.round() as u32);
    let length = |v: &str| v.trim().trim_end_matches("px").parse::<f64>().ok().and_then(number);
    if let (Some(w), Some(h)) = (attr("width").and_then(length), attr("height").and_then(length)) { return Some((w, h)); }
    let view: Vec<f64> = attr("viewBox")?.split([' ', ',']).filter(|s| !s.is_empty()).filter_map(|s| s.parse().ok()).collect();
    match view[..] { [_, _, w, h] => Some((number(w)?, number(h)?)), _ => None }
}

/// Encoded thumbnail bytes and the extension they are stored under.
type Thumb = (Vec<u8>, &'static str);

/// Pixel size and a JPEG (PNG with alpha) at most `THUMB_WIDTH` wide. Best effort:
/// undecodable images get neither, and images that are already small no thumbnail.
fn thumbnail(bytes: &[u8], ext: &str) -> (Option<(u32, u32)>, Option<Thumb>) {
    // GIFs decode to their first frame, so the thumbnail is still.
    let format = match ext { "png" => ImageFormat::Png, "jpg" => ImageFormat::Jpeg, "gif" => ImageFormat::Gif, _ => ImageFormat::WebP };
    let mut reader = ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = Limits::default();
    (limits.max_image_width, limits.max_image_height, limits.max_alloc) = (Some(MAX_DECODE_SIDE), Some(MAX_DECODE_SIDE), Some(MAX_DECODE_ALLOC));
    reader.limits(limits);
    let Ok(image) = reader.decode() else { return (None, None) };
    let size = Some((image.width(), image.height()));
    if image.width() <= THUMB_WIDTH { return (size, None); }
    let small = image.resize(THUMB_WIDTH, u32::MAX, FilterType::Triangle);
    let mut out = Vec::new();
    let encoded = if small.color().has_alpha() {
        small.write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png).ok().map(|_| "thumb.png")
    } else {
        JpegEncoder::new_with_quality(&mut out, 80).encode_image(&small.to_rgb8()).ok().map(|_| "thumb.jpg")
    };
    (size, encoded.map(|ext| (out, ext)))
}

/// Reads a workspace image without following any link on the way, checking type and size.
pub fn read_image(root: &Path, path: &str) -> Result<(Vec<u8>, &'static str)> {
    if path.len() > 4096 || path.contains('\0') { return Err("Invalid image path.".into()); }
    let relative = Path::new(path);
    let ext = match relative.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "png",
        Some("jpg" | "jpeg") => "jpg",
        Some("webp") => "webp",
        Some("gif") => "gif",
        _ => return Err("Screenshots must be .png, .jpg, .jpeg, .webp or .gif.".into()),
    };
    let mut target = root.canonicalize().map_err(|_| "Checkout is unavailable.")?;
    for part in relative.components() {
        match part {
            Component::Normal(name) if !name.eq_ignore_ascii_case(".git") => target.push(name),
            Component::CurDir => continue,
            _ => return Err("The image path must be relative and stay inside the checkout.".into()),
        }
        let meta = fs::symlink_metadata(&target).map_err(|_| format!("No image at {path}."))?;
        if meta.file_type().is_symlink() { return Err("The image path must not go through a link.".into()); }
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW);
    let file = options.open(&target).map_err(|_| format!("Could not open {path}; links are not followed."))?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() { return Err(format!("{path} is not a file.")); }
    if meta.len() > MAX_IMAGE { return Err("Screenshots are limited to 8 MB.".into()); }
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_IMAGE { return Err("Screenshots are limited to 8 MB.".into()); }
    let sniffed = match ext {
        "png" => bytes.starts_with(b"\x89PNG"),
        "jpg" => bytes.starts_with(b"\xFF\xD8\xFF"),
        "gif" => bytes.starts_with(b"GIF8"),
        _ => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
    };
    if !sniffed { return Err(format!("{path} is not a valid .{ext} image.")); }
    Ok((bytes, ext))
}

fn session_name(session_id: &str) -> Result<&str> {
    let ok = (1..=64).contains(&session_id.len()) && session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok { Ok(session_id) } else { Err("Invalid task id.".into()) }
}

/// `base/<session>`; `create` makes it. Neither step may be a link.
fn session_dir(base: &Path, session_id: &str, create: bool) -> Result<Option<PathBuf>> {
    let dir = base.join(session_name(session_id)?);
    for step in [base, dir.as_path()] {
        match fs::symlink_metadata(step) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => return Err("The progress folder must be a folder, not a link.".into()),
            Ok(_) => {}
            Err(_) if create => fs::create_dir_all(step).map_err(|e| format!("Could not create the progress folder: {e}"))?,
            Err(_) => return Ok(None),
        }
    }
    Ok(Some(dir))
}

/// Reads a regular, non-linked file up to `limit` bytes; `None` when it is missing.
fn read_bounded(path: &Path, limit: u64) -> Result<Option<Vec<u8>>> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if !meta.is_file() || meta.len() > limit { return Err("Progress file is not a regular file or is too large.".into()); }
    let mut bytes = Vec::new();
    fs::File::open(path).map_err(|e| e.to_string())?.take(limit + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit { return Err("Progress file grew while reading.".into()); }
    Ok(Some(bytes))
}

/// Replaces `path` atomically; never follows a link at the target.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) { return Err("Progress files must be regular files, not links.".into()); }
    let temp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&temp, path).map_err(|e| { let _ = fs::remove_file(&temp); e.to_string() })
}

pub fn list(base: &Path, session_id: &str) -> Result<Vec<Snapshot>> {
    let Some(dir) = session_dir(base, session_id, false)? else { return Ok(Vec::new()) };
    match read_bounded(&dir.join(INDEX), MAX_INDEX)? {
        None => Ok(Vec::new()),
        Some(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("Progress history is not valid: {e}")),
    }
}

fn stored_bytes(dir: &Path) -> u64 {
    fs::read_dir(dir).into_iter().flatten().flatten().filter_map(|e| fs::symlink_metadata(e.path()).ok()).map(|m| m.len()).sum()
}

pub fn save(base: &Path, session_id: &str, draft: Draft, media: Media) -> Result<Snapshot> {
    save_within(base, session_id, draft, media, MAX_SESSION_BYTES)
}

fn save_within(base: &Path, session_id: &str, draft: Draft, media: Media, cap: u64) -> Result<Snapshot> {
    session_name(session_id)?;
    // Decoding and resizing happen before the lock, so one large image never holds up other tasks.
    let (kind, ext, size, thumb, bytes) = match media {
        Media::Image(bytes, ext) => {
            let (size, thumb) = thumbnail(&bytes, ext);
            (Kind::Image, ext, size, thumb, bytes)
        }
        Media::Svg(svg) => (Kind::Idea, "svg", svg_size(&svg), None, svg.into_bytes()),
    };
    let _guard = WRITE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let current = list(base, session_id)?;
    if current.len() >= MAX_SNAPSHOTS { return Err(format!("This task already has {MAX_SNAPSHOTS} progress snapshots, the most PandaCode keeps.")); }
    let dir = session_dir(base, session_id, true)?.ok_or("Could not create the progress folder.")?;
    let id = uuid::Uuid::new_v4().to_string();
    let adding = (bytes.len() + thumb.as_ref().map_or(0, |(t, _)| t.len())) as u64;
    if stored_bytes(&dir) + adding > cap {
        return Err(format!("This task's progress snapshots already use most of the {} MB PandaCode keeps; ask the user to clear them.", cap / (1024 * 1024)));
    }
    let created_at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    let iteration = current.iter().map(|s| s.iteration).max().unwrap_or(0) + 1;
    let snapshot = Snapshot { id: id.clone(), iteration, title: draft.title, note: draft.note, kind, annotations: draft.annotations, created_at, width: size.map(|s| s.0), height: size.map(|s| s.1) };
    let media_path = dir.join(format!("{id}.{ext}"));
    write_atomic(&media_path, &bytes)?;
    let thumb_path = thumb.map(|(data, ext)| (dir.join(format!("{id}.{ext}")), data));
    if let Some((path, data)) = &thumb_path {
        write_atomic(path, data).inspect_err(|_| { let _ = fs::remove_file(&media_path); })?;
    }
    let next: Vec<&Snapshot> = current.iter().chain([&snapshot]).collect();
    let text = serde_json::to_string_pretty(&next).map_err(|e| e.to_string())? + "\n";
    write_atomic(&dir.join(INDEX), text.as_bytes()).inspect_err(|_| {
        let _ = fs::remove_file(&media_path);
        if let Some((path, _)) = &thumb_path { let _ = fs::remove_file(path); }
    })?;
    Ok(snapshot)
}

/// The first stored `<id>.<ext>` of `extensions` as a data URL.
fn data_url(base: &Path, session_id: &str, id: &str, extensions: &[&str]) -> Result<Option<String>> {
    use base64::Engine;
    let id = uuid::Uuid::parse_str(id).map_err(|_| "Invalid snapshot id.")?.to_string();
    let dir = session_dir(base, session_id, false)?.ok_or("This task has no progress snapshots.")?;
    for ext in extensions {
        let Some(bytes) = read_bounded(&dir.join(format!("{id}.{ext}")), MAX_IMAGE)? else { continue };
        let mime = match ext.rsplit('.').next() { Some("png") => "image/png", Some("jpg") => "image/jpeg", Some("webp") => "image/webp", Some("gif") => "image/gif", _ => "image/svg+xml" };
        return Ok(Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))));
    }
    Ok(None)
}

pub fn media(base: &Path, session_id: &str, id: &str) -> Result<String> {
    data_url(base, session_id, id, &MEDIA_EXTENSIONS)?.ok_or_else(|| "That snapshot has no image.".into())
}

/// The thumbnail, or the full media when there is none (small images, GIFs, ideas).
pub fn thumb(base: &Path, session_id: &str, id: &str) -> Result<String> {
    match data_url(base, session_id, id, &THUMB_EXTENSIONS)? { Some(url) => Ok(url), None => media(base, session_id, id) }
}

/// Removes the progress of deleted tasks; best effort, errors are logged.
pub fn forget(app_data: &Path, session_ids: &[String]) {
    for id in session_ids {
        if let Err(error) = clear(&app_data.join(DIR), id) { eprintln!("Could not remove progress snapshots of {id}: {error}"); }
    }
}

pub fn clear(base: &Path, session_id: &str) -> Result<()> {
    let _guard = WRITE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = base.join(session_name(session_id)?);
    match fs::symlink_metadata(&dir) {
        Ok(meta) if meta.file_type().is_symlink() => fs::remove_file(&dir).map_err(|e| e.to_string()),
        Ok(_) => fs::remove_dir_all(&dir).map_err(|e| e.to_string()),
        Err(_) => Ok(()),
    }
}

// ---- IPC ----

/// The store folder for a real task.
fn base(app: &tauri::AppHandle, session_id: &str) -> Result<PathBuf> {
    session_name(session_id)?;
    app.state::<AppState>().store.lock().map_err(|e| e.to_string())?.session(session_id)?;
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(DIR))
}

#[tauri::command]
pub async fn progress_list(app: tauri::AppHandle, session_id: String) -> Result<Vec<Snapshot>> {
    crate::blocking(move || list(&base(&app, &session_id)?, &session_id)).await
}
#[tauri::command]
pub async fn progress_media(app: tauri::AppHandle, session_id: String, id: String) -> Result<String> {
    crate::blocking(move || media(&base(&app, &session_id)?, &session_id, &id)).await
}
#[tauri::command]
pub async fn progress_thumb(app: tauri::AppHandle, session_id: String, id: String) -> Result<String> {
    crate::blocking(move || thumb(&base(&app, &session_id)?, &session_id, &id)).await
}
#[tauri::command]
pub async fn progress_clear(app: tauri::AppHandle, session_id: String) -> Result<()> {
    let (emit_app, sid) = (app.clone(), session_id.clone());
    crate::blocking(move || clear(&base(&app, &sid)?, &sid)).await?;
    let _ = emit_app.emit(EVENT, json!({"sessionId": session_id}));
    Ok(())
}

// ---- Agent tool ----

pub fn catalog() -> Vec<Value> {
    let unit = |what: &str| json!({"type":"number","minimum":0,"maximum":1,"description":what});
    let annotation = json!({"type":"object","additionalProperties":false,"required":["type","x","y"],"properties":{
        "type":{"type":"string","enum":["box","circle","arrow","pin","highlight"]},
        "x":unit("Left (or arrow start / pin) as a fraction of the image width."),
        "y":unit("Top (or arrow start / pin) as a fraction of the image height."),
        "w":unit("Width fraction; box, circle (the ellipse inside that rectangle) and highlight (a spotlight that dims the rest)."),
        "h":unit("Height fraction; box, circle and highlight."),
        "x2":unit("Arrow end x (the head)."), "y2":unit("Arrow end y (the head)."),
        "label":{"type":"string","maxLength":MAX_LABEL},
        "tone":{"type":"string","enum":["accent","info","success","warning","danger"],"description":"Default accent."},
    }});
    vec![spec("progress_snapshot", "Post one visual progress snapshot of the GUI you are building, shown to the user on PandaCode's progress timeline: a screenshot you saved in the checkout (image) or, before a UI exists, an SVG idea sketch (svg). Give exactly one. Annotations point at what changed this iteration. The image is copied, so the file can be deleted afterwards. One snapshot per iteration. Coordinates are fractions 0..1 of the image: box, circle (ellipse inside the rectangle) and highlight (spotlight dimming the rest) use x,y top-left plus w,h; arrow goes from x,y to its head at x2,y2; pins are numbered in the order given; labels are short (≤160) and show beside the mark.", json!({
        "title":{"type":"string","maxLength":MAX_TITLE,"description":"What this iteration shows."},
        "note":{"type":"string","maxLength":MAX_NOTE},
        "image":{"type":"string","maxLength":4096,"description":"Checkout-relative path of a .png, .jpg, .jpeg, .webp or .gif screenshot, up to 8 MB."},
        "svg":{"type":"string","description":"A complete <svg> document (an <?xml?> prolog or <!DOCTYPE> may precede it), up to 64 KiB."},
        "annotations":{"type":"array","maxItems":MAX_ANNOTATIONS,"items":annotation},
    }), &["title"])]
}

/// Validates, loads the media from the task's checkout and saves the snapshot.
fn snapshot(app: &tauri::AppHandle, session_id: &str, args: &Value) -> Result<Value> {
    let draft = parse(args)?;
    let media = match &draft.source {
        Source::Svg(svg) => Media::Svg(svg.clone()),
        Source::Image(path) => {
            let state = app.state::<AppState>();
            let root = {
                let store = state.store.lock().map_err(|e| e.to_string())?;
                let task = store.session(session_id)?;
                store.workspace_root(&task.project_id, Some(session_id))?
            };
            let (bytes, ext) = read_image(&root, path)?;
            Media::Image(bytes, ext)
        }
    };
    let saved = save(&base(app, session_id)?, session_id, draft, media)?;
    Ok(json!({"iteration": saved.iteration, "saved": saved}))
}

/// Add the progress snapshot tool to every harness turn.
pub fn with_progress(base: Option<ToolHost>, app: tauri::AppHandle, session_id: String, stopped: Arc<AtomicBool>) -> Option<ToolHost> {
    let mut tools = base.as_ref().map_or_else(Vec::new, |host| host.tools.clone());
    let approval_tools = base.as_ref().map_or_else(Default::default, |host| host.approval_tools.clone());
    tools.extend(catalog());
    Some(ToolHost {
        tools,
        approval_tools,
        handler: Arc::new(move |name, args| {
            let (base, app, stopped, session_id) = (base.clone(), app.clone(), stopped.clone(), session_id.clone());
            Box::pin(async move {
                if stopped.load(Ordering::SeqCst) { return Err("Task has stopped.".into()); }
                if name != TOOL {
                    return match base { Some(base) => (base.handler)(name, args).await, None => Err("Unknown PandaCode tool.".into()) };
                }
                let (emit_app, sid) = (app.clone(), session_id.clone());
                let result = crate::blocking(move || snapshot(&app, &session_id, &args)).await?;
                let _ = emit_app.emit(EVENT, json!({"sessionId": sid}));
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
    fn temp() -> Temp {
        let dir = std::env::temp_dir().join(format!("pandacode-progress-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        Temp(dir.canonicalize().unwrap())
    }
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest";
    const SID: &str = "task-1";
    fn svg_args() -> Value { json!({"title":"Idea","svg":"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"}) }

    #[test]
    fn parse_validates_arguments() {
        let ok = parse(&json!({"title":" Home ","note":"n","image":"a.png","annotations":[
            {"type":"box","x":0.1,"y":0.2,"w":0.3,"h":0.4,"label":"New header"},
            {"type":"arrow","x":0,"y":0,"x2":1,"y2":1,"tone":"success"},
            {"type":"pin","x":0.5,"y":0.5}]})).unwrap();
        assert_eq!((ok.title.as_str(), ok.annotations.len(), ok.annotations[0].tone), ("Home", 3, Tone::Accent));
        assert_eq!(ok.source, Source::Image("a.png".into()));
        assert!(parse(&svg_args()).is_ok());
        let bad = [
            json!({"svg":"<svg/>"}),
            json!({"title":"x".repeat(121),"svg":"<svg/>"}),
            json!({"title":"t","note":"x".repeat(1001),"svg":"<svg/>"}),
            json!({"title":"t"}),
            json!({"title":"t","image":"a.png","svg":"<svg/>"}),
            json!({"title":"t","svg":"<div/>"}),
            json!({"title":"t","svg":"<svg>\0"}),
            json!({"title":"t","svg":format!("<svg>{}", "x".repeat(MAX_SVG))}),
            json!({"title":"t","svg":"<svg/>","extra":1}),
            json!({"title":"t","svg":"<svg/>","annotations":[{"type":"box","x":0,"y":0}]}),
            json!({"title":"t","svg":"<svg/>","annotations":[{"type":"arrow","x":0,"y":0}]}),
            json!({"title":"t","svg":"<svg/>","annotations":[{"type":"pin","x":1.5,"y":0}]}),
            json!({"title":"t","svg":"<svg/>","annotations":[{"type":"pin","x":-0.1,"y":0}]}),
            json!({"title":"t","svg":"<svg/>","annotations":[{"type":"star","x":0,"y":0}]}),
            json!({"title":"t","svg":"<svg/>","annotations":[{"type":"pin","x":0,"y":0,"tone":"pink"}]}),
            json!({"title":"t","svg":"<svg/>","annotations":[{"type":"pin","x":0,"y":0,"label":"x".repeat(161)}]}),
            json!({"title":"t","svg":"<svg/>","annotations":vec![json!({"type":"pin","x":0,"y":0}); 25]}),
        ];
        for args in bad { assert!(parse(&args).is_err(), "{args}"); }
        // JSON cannot carry NaN; the range check still guards non-finite values.
        assert!(!in_unit(f64::NAN) && !in_unit(f64::INFINITY));
    }

    #[test]
    fn images_stay_inside_the_checkout_and_are_capped() {
        let t = temp();
        fs::create_dir_all(t.0.join("shots")).unwrap();
        fs::write(t.0.join("shots/a.png"), PNG).unwrap();
        assert_eq!(read_image(&t.0, "shots/a.png").unwrap(), (PNG.to_vec(), "png"));
        fs::create_dir_all(t.0.join(".GIT")).unwrap();
        fs::write(t.0.join(".GIT/a.png"), PNG).unwrap();
        fs::write(t.0.join("fake.png"), "text").unwrap();
        fs::write(t.0.join("a.bmp"), PNG).unwrap();
        fs::write(t.0.join("big.png"), vec![0u8; MAX_IMAGE as usize + 1]).unwrap();
        for bad in ["../a.png", "/etc/a.png", "missing.png", "fake.png", "a.bmp", "big.png", "shots", ".git/a.png", ".GIT/a.png", "x/.Git/a.png"] {
            assert!(read_image(&t.0, bad).is_err(), "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn images_refuse_links() {
        let (t, outside) = (temp(), temp());
        fs::write(outside.0.join("secret.png"), PNG).unwrap();
        std::os::unix::fs::symlink(outside.0.join("secret.png"), t.0.join("leak.png")).unwrap();
        std::os::unix::fs::symlink(&outside.0, t.0.join("dir")).unwrap();
        fs::write(t.0.join("real.png"), PNG).unwrap();
        std::os::unix::fs::symlink(t.0.join("real.png"), t.0.join("inside.png")).unwrap();
        for bad in ["leak.png", "dir/secret.png", "inside.png"] { assert!(read_image(&t.0, bad).is_err(), "{bad}"); }
    }

    #[test]
    fn saves_numbers_lists_reads_and_clears() {
        let base = temp();
        assert!(list(&base.0, SID).unwrap().is_empty());
        let first = save(&base.0, SID, parse(&json!({"title":"Shot","image":"a.png"})).unwrap(), Media::Image(PNG.to_vec(), "png")).unwrap();
        let second = save(&base.0, SID, parse(&svg_args()).unwrap(), Media::Svg("<svg/>".into())).unwrap();
        assert_eq!((first.iteration, first.kind, second.iteration, second.kind), (1, Kind::Image, 2, Kind::Idea));
        let listed = list(&base.0, SID).unwrap();
        assert_eq!(listed, vec![first.clone(), second.clone()]);
        let index = fs::read_to_string(base.0.join(SID).join(INDEX)).unwrap();
        assert!(index.contains("\"createdAt\"") && index.contains("\"kind\": \"idea\"") && !index.contains("\"note\""));
        assert!(media(&base.0, SID, &first.id).unwrap().starts_with("data:image/png;base64,iVBOR"));
        assert!(media(&base.0, SID, &second.id).unwrap().starts_with("data:image/svg+xml;base64,"));
        assert!(media(&base.0, SID, "../index").is_err());
        assert!(media(&base.0, SID, &uuid::Uuid::new_v4().to_string()).is_err());
        assert!(list(&base.0, "../x").is_err() && list(&base.0, "a/b").is_err() && list(&base.0, "").is_err());
        clear(&base.0, SID).unwrap();
        assert!(list(&base.0, SID).unwrap().is_empty());
        clear(&base.0, SID).unwrap();
        // A cleared history starts again at iteration 1.
        let third = save(&base.0, SID, parse(&svg_args()).unwrap(), Media::Svg("<svg/>".into())).unwrap();
        assert_eq!(third.iteration, 1);
    }

    #[test]
    fn refuses_past_the_snapshot_cap() {
        let base = temp();
        let dir = base.0.join(SID);
        fs::create_dir_all(&dir).unwrap();
        let one = Snapshot { id: uuid::Uuid::new_v4().to_string(), iteration: 1, title: "t".into(), note: None, kind: Kind::Idea, annotations: vec![], created_at: 1, width: None, height: None };
        let full: Vec<Snapshot> = (1..=MAX_SNAPSHOTS as u32).map(|iteration| Snapshot { iteration, ..one.clone() }).collect();
        fs::write(dir.join(INDEX), serde_json::to_string(&full).unwrap()).unwrap();
        let err = save(&base.0, SID, parse(&svg_args()).unwrap(), Media::Svg("<svg/>".into())).unwrap_err();
        assert!(err.contains("200"), "{err}");
    }

    fn encoded(image: image::DynamicImage) -> Vec<u8> {
        let mut out = Vec::new();
        image.write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png).unwrap();
        out
    }
    fn shot() -> Draft { parse(&json!({"title":"Shot","image":"a.png"})).unwrap() }

    #[test]
    fn thumbnails_and_sizes() {
        let base = temp();
        let wide = save(&base.0, SID, shot(), Media::Image(encoded(image::DynamicImage::new_rgb8(640, 480)), "png")).unwrap();
        assert_eq!((wide.width, wide.height), (Some(640), Some(480)));
        let thumb_path = base.0.join(SID).join(format!("{}.thumb.jpg", wide.id));
        let small = image::load_from_memory(&fs::read(thumb_path).unwrap()).unwrap();
        assert_eq!((small.width(), small.height()), (320, 240));
        assert!(thumb(&base.0, SID, &wide.id).unwrap().starts_with("data:image/jpeg;base64,"));
        let alpha = save(&base.0, SID, shot(), Media::Image(encoded(image::DynamicImage::new_rgba8(800, 100)), "png")).unwrap();
        assert!(base.0.join(SID).join(format!("{}.thumb.png", alpha.id)).exists());
        let tiny = save(&base.0, SID, shot(), Media::Image(encoded(image::DynamicImage::new_rgb8(100, 50)), "png")).unwrap();
        assert_eq!((tiny.width, tiny.height), (Some(100), Some(50)));
        assert_eq!(thumb(&base.0, SID, &tiny.id).unwrap(), media(&base.0, SID, &tiny.id).unwrap());
        let mut gif_bytes = Vec::new();
        image::DynamicImage::new_rgb8(640, 320).write_to(&mut std::io::Cursor::new(&mut gif_bytes), ImageFormat::Gif).unwrap();
        let gif = save(&base.0, SID, shot(), Media::Image(gif_bytes, "gif")).unwrap();
        assert_eq!((gif.width, gif.height), (Some(640), Some(320)));
        let gif_thumb = thumb(&base.0, SID, &gif.id).unwrap();
        assert!(gif_thumb.starts_with("data:image/jpeg;base64,") || gif_thumb.starts_with("data:image/png;base64,"), "{}", &gif_thumb[..30]);
        assert_ne!(gif_thumb, media(&base.0, SID, &gif.id).unwrap());
        // Undecodable bytes still save, without a size.
        let odd = save(&base.0, SID, shot(), Media::Image(PNG.to_vec(), "png")).unwrap();
        assert_eq!(odd.width, None);
        let idea = save(&base.0, SID, parse(&svg_args()).unwrap(), Media::Svg("<svg width=\"400px\" height=\"300\"/>".into())).unwrap();
        assert_eq!((idea.width, idea.height), (Some(400), Some(300)));
        assert!(thumb(&base.0, SID, &idea.id).unwrap().starts_with("data:image/svg+xml;base64,"));
        assert_eq!(svg_size("<?xml version=\"1.0\"?><svg viewBox=\"0 0 1280,720\">"), Some((1280, 720)));
        assert_eq!(svg_size("<svg xmlns=\"x\">"), None);
        // Entries written before width/height existed still read.
        let old: Snapshot = serde_json::from_value(json!({"id":"x","iteration":1,"title":"t","kind":"image","annotations":[],"createdAt":1})).unwrap();
        assert_eq!(old.width, None);
        assert!(!serde_json::to_string(&old).unwrap().contains("width"));
    }

    #[test]
    fn svg_may_start_with_a_prolog() {
        for ok in ["<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg/>", "<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"x\">\n<svg/>", "<?xml version=\"1.0\"?><!DOCTYPE svg><svg/>"] {
            assert!(parse(&json!({"title":"t","svg":ok})).is_ok(), "{ok}");
        }
        assert!(parse(&json!({"title":"t","svg":"<?xml version=\"1.0\"?><div/>"})).is_err());
    }

    #[test]
    fn byte_cap_and_forget() {
        let base = temp();
        save_within(&base.0, SID, parse(&svg_args()).unwrap(), Media::Svg("<svg/>".repeat(100)), 1000).unwrap();
        let err = save_within(&base.0, SID, parse(&svg_args()).unwrap(), Media::Svg("<svg/>".repeat(100)), 1000).unwrap_err();
        assert!(err.contains("MB"), "{err}");
        assert_eq!(list(&base.0, SID).unwrap().len(), 1);
        // Deleting tasks removes their folders under app data and leaves others.
        let app_data = temp();
        let other = "task-2".to_string();
        save(&app_data.0.join(DIR), SID, parse(&svg_args()).unwrap(), Media::Svg("<svg/>".into())).unwrap();
        save(&app_data.0.join(DIR), &other, parse(&svg_args()).unwrap(), Media::Svg("<svg/>".into())).unwrap();
        forget(&app_data.0, &[SID.to_string(), "../bad".to_string()]);
        assert!(list(&app_data.0.join(DIR), SID).unwrap().is_empty());
        assert_eq!(list(&app_data.0.join(DIR), &other).unwrap().len(), 1);
    }

    #[test]
    fn catalog_names_the_tool() {
        assert_eq!(catalog()[0]["name"], TOOL);
    }
}
