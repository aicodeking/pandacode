//! Panel folders served from isolated, persistent per-package origins (R0302, ADR-0001, contract G2).
//!
//! A rich view may declare, besides the legacy three inline files, a **folder** of the archive with an **entry**
//! page (`rich.folder`, `rich.entry`), or a **remote** page (`rich.url`), and up to sixteen remote origins it loads
//! pages or frames from (`rich.remote`, shown at install).
//!
//! - **Origin.** Every package's panels are served by the `pandapanel` scheme from one origin that belongs to that
//!   package alone: `http://pandapanel.<key>.localhost` on Windows (WebView2 reaches custom schemes through this
//!   form), `pandapanel://<key>.localhost` elsewhere, with `<key>` = `p` + 32 hex digits of a SHA-256 of the package
//!   id. It differs from the app's and from every other package's, and it is the same for every version, restart,
//!   placement and window, so the page's own storage (local storage, IndexedDB, the cache API) is shared by that
//!   package's panels and survives restarts and updates. Two packages that use the same storage key never meet.
//! - **Shell.** The panel webview (inspector) and the separate window navigate to the host's shell on the package's
//!   origin, `/~panda/shell/<webview label>`, which frames the entry (same origin, so its storage is first-party) or
//!   the remote page. The shell owns the heartbeat title of R0301; a page that loops blocks its same-origin shell and
//!   the host watchdog ends it. Its policy pins its own frame to the package origin and `rich.remote`; a frame that
//!   navigates elsewhere is shown as failed with a reload control. Package pages get **no** host content policy.
//! - **Files.** Relative addresses, module imports, images, fonts, media and WebAssembly resolve inside the folder
//!   with their media types; a path outside it answers a 404 page that says so. `~` never occurs in an archive name,
//!   so `/~panda/` is the host's own namespace. HTML pages of the folder receive the client script
//!   (`/~panda/client.js`: `pandaView`, `pandaView.baseUrl`) as their first script.
//! - **Ownership.** A package origin answers only the webviews mounted for that package: the app's own window and a
//!   panel of another package get a 403 page (foreign owner, interface stability), never a native command — panel
//!   webviews have no command grant at all (R0301).
//! - **Budget.** The served folders of all live panels together hold at most `SERVED_BUDGET` bytes in memory; past
//!   it a mount answers `LimitExceeded` with a note naming the budget (memory of the app, not a security limit).
//! - **Update.** The origin and the page's storage stay; a live panel of the previous archive generation is ended
//!   with reason `changed` ("reload the panel to show the new version") because its pin includes the archive digest.
//! - **Remove own data.** Leaves a marker; the next shell of that package clears the page's storage once before it
//!   frames the entry, then removes the marker (`/~panda/wiped`).
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::{Path, PathBuf}, sync::{Arc, LazyLock, Mutex}};

pub const SCHEME: &str = "pandapanel";
/// The host's own path namespace on every package origin (`~` never occurs in an archive name).
pub const RESERVED: &str = "~panda";
pub const MAX_REMOTE: usize = 16;
pub const MAX_ENTRY: usize = 256;
pub const MAX_URL: usize = 1024;
/// Bytes of served panel folders held in memory at once, across every live panel and window.
pub const SERVED_BUDGET: u64 = 256 * 1024 * 1024;
const PANEL_DATA: &str = "extension-panel-v1";
const SHELL_STYLE: &str = "html,body{margin:0;height:100%;font:13px system-ui,sans-serif}body{display:flex;flex-direction:column}p[role=status]{margin:4px 8px;opacity:.7}iframe{flex:1;border:0;width:100%;min-height:0}";
const NOT_SERVED: &str = "This address belongs to an extension panel. It is served only to that package's panels.";

/// The two served forms of `rich` (the legacy `html`/`css`/`script` triple stays in `rich_views`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    Folder { folder: String, entry: String, remote: Vec<String> },
    Remote { url: String, remote: Vec<String> },
}
impl Source {
    pub fn remote(&self) -> &[String] { match self { Source::Folder { remote, .. } | Source::Remote { remote, .. } => remote } }
}

fn invalid(message: impl Into<String>) -> String { format!("InvalidShape: {}", message.into()) }
/// `https://host[:port]`, lowercase host, no path: one entry of `rich.remote`.
pub fn valid_origin(origin: &str) -> bool {
    let Some(rest) = origin.strip_prefix("https://") else { return false };
    let (host, port) = match rest.rsplit_once(':') { Some((host, port)) => (host, Some(port)), None => (rest, None) };
    origin.len() <= 260 && !host.is_empty() && host.len() <= 253 && !host.starts_with(['.', '-']) && !host.ends_with(['.', '-']) && !host.contains("..")
        && host.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'.' || byte == b'-')
        && port.is_none_or(|port| !port.is_empty() && port.len() <= 5 && port.bytes().all(|byte| byte.is_ascii_digit()) && port.parse::<u32>().is_ok_and(|port| (1..=65535).contains(&port)))
}
/// The origin of an `https` address (`None` when it has none the host accepts).
pub fn origin_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let origin = format!("https://{}", &rest[..end]);
    valid_origin(&origin).then_some(origin)
}
/// A page path relative to the folder: segments of `[A-Za-z0-9_.-]` that never start with `.` (so no `.` or `..`).
pub fn valid_entry(entry: &str) -> bool {
    !entry.is_empty() && entry.len() <= MAX_ENTRY && entry.split('/').all(|part| !part.is_empty() && !part.starts_with('.') && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte)))
}
fn remote_list(rich: &Value, required: bool) -> Result<Vec<String>, String> {
    let Some(items) = rich.get("remote") else { return if required { Err(invalid("a remote page needs rich.remote.")) } else { Ok(vec![]) } };
    let items = items.as_array().filter(|items| !items.is_empty() && items.len() <= MAX_REMOTE).ok_or_else(|| invalid("rich.remote lists 1 to 16 origins."))?;
    let mut origins = Vec::new();
    for item in items {
        let origin = item.as_str().filter(|origin| valid_origin(origin)).ok_or_else(|| invalid(format!("{item} is not an https origin (https://host[:port], lowercase, no path).")))?;
        if !origins.iter().any(|known| known == origin) { origins.push(origin.to_owned()); }
    }
    Ok(origins)
}
/// Classifies a view's `rich`: `Ok(None)` for the legacy triple, else the served form with its checks (the
/// schema's closed alternatives, plus the rule that a remote page's origin is listed in `rich.remote`).
pub fn source(rich: &Value) -> Result<Option<Source>, String> {
    let has = |key: &str| rich.get(key).is_some();
    if has("html") || has("css") || has("script") {
        if has("folder") || has("entry") || has("url") || has("remote") { return Err(invalid("a rich view is either inline files, a folder or a remote page, never a mix.")); }
        return Ok(None);
    }
    if has("folder") {
        if has("url") { return Err(invalid("a rich view is either a folder or a remote page, never both.")); }
        let folder = rich["folder"].as_str().filter(|folder| super::super::packages::runtime_code_folders::valid_folder(folder)).ok_or_else(|| invalid("rich.folder is an archive folder name (lowercase letters, digits, - and _)."))?;
        let entry = rich["entry"].as_str().filter(|entry| valid_entry(entry)).ok_or_else(|| invalid("rich.entry is a page path inside the folder (no leading /, no . or .. segments, at most 256 characters)."))?;
        return Ok(Some(Source::Folder { folder: folder.into(), entry: entry.into(), remote: remote_list(rich, false)? }));
    }
    if has("url") {
        if has("entry") { return Err(invalid("a remote page has no rich.entry.")); }
        let url = rich["url"].as_str().filter(|url| url.len() <= MAX_URL && !url.chars().any(char::is_whitespace)).ok_or_else(|| invalid("rich.url is an https address of at most 1,024 characters."))?;
        let origin = origin_of(url).ok_or_else(|| invalid(format!("{url} is not an https address with a lowercase host.")))?;
        let remote = remote_list(rich, true)?;
        if !remote.contains(&origin) { return Err(invalid(format!("the origin of rich.url ({origin}) is not listed in rich.remote."))); }
        return Ok(Some(Source::Remote { url: url.into(), remote }));
    }
    Err(invalid("a rich view declares html/css/script, folder/entry or url."))
}

/// Install-time check of a served view against the archive (`names` = every archive file). Answers the archive
/// files the view declares (every file of its folder, of any type), or a refusal that says what is wrong.
pub fn check_archive(view: &Value, names: &[&str]) -> Result<Vec<String>, String> {
    let id = view["id"].as_str().unwrap_or("rich view");
    match source(&view["rich"]).map_err(|error| format!("Rich view {id}: {error}"))? {
        None => Ok(vec![]),
        Some(Source::Remote { .. }) => Ok(vec![]),
        Some(Source::Folder { folder, entry, .. }) => {
            let prefix = format!("{folder}/");
            let files: Vec<String> = names.iter().filter(|name| name.starts_with(&prefix) && name.len() > prefix.len()).map(|name| (*name).to_owned()).collect();
            if files.is_empty() { return Err(format!("Rich view {id}: the panel folder {folder}/ is empty or missing from the archive.")); }
            if !files.iter().any(|name| *name == format!("{prefix}{entry}")) { return Err(format!("Rich view {id}: the entry page {folder}/{entry} is not in the archive.")); }
            Ok(files)
        }
    }
}

/// The per-package origin key: `p` + 32 hex digits of SHA-256 over the package id. Stable for every version and
/// restart, a valid DNS label, different for every package.
pub fn origin_key(id: &str) -> String {
    let digest = Sha256::digest(format!("pandacode-panel-origin-v1:{id}").as_bytes());
    format!("p{}", digest.iter().take(16).map(|byte| format!("{byte:02x}")).collect::<String>())
}
/// The origin a package's panels are served from on this platform.
pub fn origin(key: &str) -> String {
    if cfg!(any(windows, target_os = "android")) { format!("http://{SCHEME}.{key}.localhost") } else { format!("{SCHEME}://{key}.localhost") }
}
pub fn shell_url(key: &str, label: &str) -> String { format!("{}/{RESERVED}/shell/{label}", origin(key)) }
/// `(key, path)` of a request to the scheme, in any of the forms the engines hand over (the Windows
/// `http(s)://pandapanel.<key>.localhost/...` and the native `pandapanel://<key>.localhost/...`). Query and fragment
/// are dropped.
pub fn parse(uri: &str) -> Option<(String, String)> {
    let rest = uri.strip_prefix(&format!("{SCHEME}://"))
        .or_else(|| uri.strip_prefix(&format!("http://{SCHEME}.")))
        .or_else(|| uri.strip_prefix(&format!("https://{SCHEME}.")))?;
    let end = rest.find('/').unwrap_or(rest.len());
    let host = &rest[..end];
    let key = host.strip_suffix(".localhost").unwrap_or(host);
    if key.len() != 33 || !key.starts_with('p') || !key[1..].bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) { return None; }
    let path = &rest[end..];
    let path = &path[..path.find(['?', '#']).unwrap_or(path.len())];
    Some((key.to_owned(), if path.is_empty() { "/".into() } else { path.to_owned() }))
}
fn percent_decode(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            index += 3;
        } else { out.push(bytes[index]); index += 1; }
    }
    String::from_utf8(out).ok()
}
/// The folder-relative file a request path names, or `None` when it leaves the folder or is malformed (`..`, `.`,
/// empty segments, backslashes, control characters). A directory path names its `index.html`.
pub fn folder_path(path: &str) -> Option<String> {
    let decoded = percent_decode(path)?;
    let relative = decoded.strip_prefix('/')?;
    let relative = if relative.is_empty() || relative.ends_with('/') { format!("{relative}index.html") } else { relative.to_owned() };
    (relative.len() <= 1024 && !relative.contains('\\') && !relative.chars().any(char::is_control) && relative.split('/').all(|part| !part.is_empty() && part != "." && part != "..")).then_some(relative)
}
/// The media type a served file carries (module scripts need a JavaScript type).
pub fn media_type(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, extension)| extension.to_ascii_lowercase()).as_deref() {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("js" | "mjs" | "cjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map" | "webmanifest") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("ico") => "image/x-icon",
        Some("wasm") => "application/wasm",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("txt" | "md" | "csv") => "text/plain; charset=utf-8",
        Some("xml") => "application/xml",
        _ => "application/octet-stream",
    }
}
/// Puts the client script first in an HTML page (after `<head>`, else after `<html>`, else at the start).
pub fn inject_client(html: &[u8], session: &str) -> Vec<u8> {
    let tag = format!("<script src=\"/{RESERVED}/client.js\" data-panda-session=\"{session}\"></script>");
    let lower = String::from_utf8_lossy(html).to_ascii_lowercase();
    // `<head` must end its name (not `<header`): followed by `>`, `/` or white space.
    let after = |name: &str| lower.match_indices(name).map(|(start, _)| start)
        .find(|start| lower.as_bytes().get(start + name.len()).is_some_and(|next| matches!(next, b'>' | b'/' | b' ' | b'\t' | b'\n' | b'\r')))
        .and_then(|start| lower[start..].find('>').map(|end| start + end + 1));
    let at = after("<head").or_else(|| after("<html")).unwrap_or(0);
    // `to_ascii_lowercase` keeps byte offsets of valid UTF-8; a lossy page falls back to the start.
    let at = if lower.len() == html.len() { at } else { 0 };
    [&html[..at], tag.as_bytes(), &html[at..]].concat()
}

/// One response of the scheme.
#[derive(Debug, PartialEq)]
pub struct Reply { pub status: u16, pub content_type: &'static str, pub headers: Vec<(&'static str, String)>, pub body: Vec<u8> }
impl Reply {
    fn new(status: u16, content_type: &'static str, body: Vec<u8>) -> Self { Reply { status, content_type, headers: vec![("Cache-Control", "no-store".into())], body } }
    /// A small page the panel shows in place of what it asked for, saying why.
    fn page(status: u16, title: &str, detail: &str) -> Self {
        let escape = |text: &str| text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
        Reply::new(status, "text/html; charset=utf-8", format!("<!doctype html><html><head><meta charset=\"utf-8\"><title>{}</title></head><body><h1>{}</h1><p>{}</p></body></html>", escape(title), escape(title), escape(detail)).into_bytes())
    }
}

/// A folder served for one package (shared by all of its live mounts).
struct Served { owner: String, generation: String, files: Arc<BTreeMap<String, Vec<u8>>>, bytes: u64, wipe: Option<PathBuf> }
/// One live mount (an inspector panel or a separate window), keyed by its webview label.
#[derive(Clone)]
pub struct Mount { pub key: String, pub session: String, pub src: String, pub remote: Vec<String>, pub expects_client: bool, pub dto: Value, pub theme: Value }
/// What the scheme serves. One per app (`REGISTRY`); tests build their own.
#[derive(Default)]
pub struct Registry { served: BTreeMap<String, Served>, mounts: BTreeMap<String, Mount> }
static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(Mutex::default);

impl Registry {
    /// Registers the mount `label` of `owner` at archive `generation`. `files` are the folder's files (relative to
    /// it; `None` for a remote page). A new generation replaces the folder (the previous one's mounts are being
    /// ended as `changed`). Refuses past the in-memory budget.
    pub fn admit(&mut self, label: &str, owner: &str, generation: &str, files: Option<Vec<(String, Vec<u8>)>>, wipe: Option<PathBuf>, mount: Mount) -> Result<(), String> {
        self.admit_within(SERVED_BUDGET, label, owner, generation, files, wipe, mount)
    }
    #[allow(clippy::too_many_arguments)]
    fn admit_within(&mut self, budget: u64, label: &str, owner: &str, generation: &str, files: Option<Vec<(String, Vec<u8>)>>, wipe: Option<PathBuf>, mount: Mount) -> Result<(), String> {
        let key = origin_key(owner);
        if mount.key != key { return Err("PermissionDenied".into()); }
        let current = self.served.get(&key).is_some_and(|served| served.owner == owner && served.generation == generation);
        if !current {
            let files: BTreeMap<String, Vec<u8>> = files.unwrap_or_default().into_iter().collect();
            let bytes: u64 = files.values().map(|bytes| bytes.len() as u64).sum();
            let others: u64 = self.served.iter().filter(|(other, _)| **other != key).map(|(_, served)| served.bytes).sum();
            if others + bytes > budget {
                return Err(format!("LimitExceeded: open extension panels would hold more than {} MiB of panel assets. Close a panel of another package, then reload this one.", budget >> 20));
            }
            self.served.insert(key.clone(), Served { owner: owner.into(), generation: generation.into(), files: Arc::new(files), bytes, wipe });
        } else if let (Some(served), Some(wipe)) = (self.served.get_mut(&key), wipe) { served.wipe = Some(wipe); }
        self.mounts.insert(label.into(), mount);
        Ok(())
    }
    /// Forgets a mount; the folder goes when no mount of its package is left.
    pub fn release(&mut self, label: &str) {
        let Some(mount) = self.mounts.remove(label) else { return };
        if !self.mounts.values().any(|other| other.key == mount.key) { self.served.remove(&mount.key); }
    }
    pub fn held_bytes(&self) -> u64 { self.served.values().map(|served| served.bytes).sum() }

    /// The answer to `method uri` from the webview `label`.
    pub fn respond(&mut self, label: &str, method: &str, uri: &str) -> Reply {
        if method != "GET" && method != "HEAD" { return Reply::page(405, "Method not allowed", "Panel files are read-only."); }
        let mut reply = self.reply(label, uri);
        if method == "HEAD" { reply.body.clear(); }
        reply
    }
    fn reply(&mut self, label: &str, uri: &str) -> Reply {
        let Some((key, path)) = parse(uri) else { return Reply::page(404, "Not a panel address", NOT_SERVED) };
        let Some(mount) = self.mounts.get(label).cloned() else { return Reply::page(403, "Not served here", NOT_SERVED) };
        if mount.key != key {
            let owner = self.served.get(&mount.key).map(|served| served.owner.clone()).unwrap_or_default();
            return Reply::page(403, "Another package's address", &format!("This panel belongs to {owner}; {} belongs to another package, whose files are served only to its own panels.", origin(&key)));
        }
        let Some(served) = self.served.get_mut(&key) else { return Reply::page(404, "Panel closed", NOT_SERVED) };
        if let Some(rest) = path.strip_prefix(&format!("/{RESERVED}/")) {
            return match rest {
                "client.js" => Reply::new(200, "text/javascript; charset=utf-8", format!("{}\n{}", super::CHANNEL, super::CLIENT).into_bytes()),
                "wiped" => { if let Some(marker) = served.wipe.take() { let _ = std::fs::remove_file(marker); } Reply::new(204, "text/plain; charset=utf-8", vec![]) }
                _ if rest.strip_prefix("shell/") == Some(label) => {
                    let (html, policy) = shell_document(&mount, &origin(&key), served.wipe.is_some());
                    let mut reply = Reply::new(200, "text/html; charset=utf-8", html.into_bytes());
                    reply.headers.push(("Content-Security-Policy", policy));
                    reply
                }
                _ => Reply::page(404, "Not a host file", &format!("/{RESERVED}/ is the host's own namespace on a panel origin.")),
            };
        }
        let Some(relative) = folder_path(&path) else { return Reply::page(404, "Outside the panel folder", &format!("{path} is not a path inside this panel's folder.")) };
        match served.files.get(&relative) {
            Some(bytes) if media_type(&relative).starts_with("text/html") => Reply::new(200, media_type(&relative), inject_client(bytes, &mount.session)),
            Some(bytes) => Reply::new(200, media_type(&relative), bytes.clone()),
            None => Reply::page(404, "Not in the panel folder", &format!("{relative} is not a file of this panel's folder. Paths resolve relative to the folder; check the address and the archive.")),
        }
    }
}

/// The shell on the package origin: frames the entry (or the remote page) and carries the heartbeat. Its own
/// policy pins the frame to the package origin and `rich.remote`; package pages get no policy.
pub fn shell_document(mount: &Mount, own_origin: &str, wipe: bool) -> (String, String) {
    let script = format!("{}\n{}", super::CHANNEL, super::HOST);
    let frames: String = mount.remote.iter().map(|origin| format!(" {origin}")).collect();
    let policy = format!("default-src 'none'; script-src {}; style-src {}; frame-src 'self'{frames}; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'", super::hash(&script), super::hash(SHELL_STYLE));
    let config = super::escaped_json(&json!({"session": mount.session, "src": mount.src, "origin": own_origin, "frameOrigins": mount.remote, "expectsClient": mount.expects_client, "wipe": wipe, "dto": mount.dto, "theme": mount.theme}));
    (format!("<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"referrer\" content=\"no-referrer\"><title>Extension view</title><style>{SHELL_STYLE}</style></head><body><script type=\"application/json\" id=\"panda-view-config\">{config}</script><script>{script}</script></body></html>"), policy)
}

/// The mount record of a view (the same DTO and theme envelope as the legacy shell).
pub fn mount_for(owner: &str, version: &str, view: &Value, source: &Source, label: &str, dark: bool) -> Mount {
    let (src, expects_client) = match source {
        Source::Folder { entry, .. } => (format!("/{entry}"), entry.ends_with(".html") || entry.ends_with(".htm")),
        Source::Remote { url, .. } => (url.clone(), false),
    };
    Mount {
        key: origin_key(owner), session: uuid::Uuid::new_v4().to_string(), src, remote: source.remote().to_vec(), expects_client,
        dto: json!({"schemaVersion": 1, "owner": owner, "version": version, "viewId": view["id"], "windowId": label, "title": view["title"], "text": view["text"]}),
        theme: json!({"schemaVersion": 1, "colorScheme": if dark { "dark" } else { "light" }}),
    }
}

/// The marker "remove own data" leaves for the page's storage of `id`.
pub fn wipe_marker(app_data: &Path, id: &str) -> PathBuf { app_data.join(PANEL_DATA).join(format!("{}.wipe", origin_key(id))) }
/// Called by "remove own data": the next shell of `id` clears its page storage once.
pub fn request_wipe(app_data: &Path, id: &str) -> Result<(), String> {
    let marker = wipe_marker(app_data, id);
    if let Some(parent) = marker.parent() { std::fs::create_dir_all(parent).map_err(|_| "StorageUnavailable")?; }
    std::fs::write(marker, b"").map_err(|_| "StorageUnavailable".into())
}

/// Prepares the mount `label` of a served view and answers the address its webview opens (the shell).
#[allow(clippy::too_many_arguments)]
pub fn prepare(app: &tauri::AppHandle, owner: &str, version: &str, generation: &str, view: &Value, source: &Source, label: &str, dark: bool) -> Result<String, String> {
    use tauri::Manager;
    let packages = app.state::<super::super::packages::ExtensionPackages>();
    let (files, app_data) = {
        let packages = packages.0.lock().map_err(|_| "HostUnavailable")?;
        let files = match source {
            Source::Folder { folder, .. } => {
                let (checksum, files) = packages.panel_files(owner, folder)?;
                if checksum != generation { return Err("StaleContext: the package changed while the panel opened.".into()); }
                Some(files)
            }
            Source::Remote { .. } => None,
        };
        (files, packages.app_data())
    };
    let marker = wipe_marker(&app_data, owner);
    let mount = mount_for(owner, version, view, source, label, dark);
    let key = mount.key.clone();
    REGISTRY.lock().map_err(|_| "HostUnavailable")?.admit(label, owner, generation, files, marker.is_file().then_some(marker), mount)?;
    Ok(shell_url(&key, label))
}
/// Forgets the mount `label` (every teardown path of R0301 calls this).
pub fn release(label: &str) { if let Ok(mut registry) = REGISTRY.lock() { registry.release(label); } }

/// Registers the scheme on the app builder (`lib.rs`). The handler only reads the registry: folders are loaded
/// when a mount opens, never while a request waits.
pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_uri_scheme_protocol(SCHEME, |context, request| {
        let reply = match REGISTRY.lock() {
            Ok(mut registry) => registry.respond(context.webview_label(), request.method().as_str(), &request.uri().to_string()),
            Err(_) => Reply::page(503, "Panel host unavailable", "Reload the panel."),
        };
        let mut response = tauri::http::Response::builder().status(reply.status).header("Content-Type", reply.content_type).header("X-Content-Type-Options", "nosniff");
        for (name, value) in reply.headers { response = response.header(name, value); }
        response.body(reply.body).unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::{packages::ExtensionPackages, rich_views};
    use std::io::Write;

    const ALPHA: &str = "sample.rich-assets";
    const TWIN: &str = "sample.rich-assets-twin";
    fn fixture(folder: &str) -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/extensions/runtime-rich-assets").join(folder) }
    /// Every file under a fixture package folder, as archive entries.
    fn files(folder: &str) -> Vec<(String, Vec<u8>)> {
        let root = fixture(folder);
        let mut found = vec![]; let mut pending = vec![(root.clone(), String::new())];
        while let Some((path, prefix)) = pending.pop() {
            for entry in std::fs::read_dir(path).unwrap() {
                let entry = entry.unwrap(); let name = format!("{prefix}{}", entry.file_name().to_str().unwrap());
                if entry.file_type().unwrap().is_dir() { pending.push((entry.path(), format!("{name}/"))); } else { found.push((name, std::fs::read(entry.path()).unwrap())); }
            }
        }
        found.sort(); found
    }
    fn archive(files: &[(String, Vec<u8>)]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, bytes) in files { writer.start_file(name.as_str(), zip::write::SimpleFileOptions::default()).unwrap(); writer.write_all(bytes).unwrap(); }
        writer.finish().unwrap().into_inner()
    }
    fn panel_files(folder: &str) -> Vec<(String, Vec<u8>)> { files(folder).into_iter().filter_map(|(name, bytes)| name.strip_prefix("panel/").map(|name| (name.to_owned(), bytes))).collect() }
    fn manifest(folder: &str) -> Value { serde_json::from_slice(&std::fs::read(fixture(folder).join("extension.json")).unwrap()).unwrap() }
    fn board(folder: &str) -> Value { manifest(folder)["contributes"]["views"][0].clone() }
    fn mounted(registry: &mut Registry, label: &str, owner: &str, folder: &str) -> Mount {
        let view = board(folder);
        let source = source(&view["rich"]).unwrap().unwrap();
        let mount = mount_for(owner, "1.0.0", &view, &source, label, false);
        registry.admit(label, owner, "generation-1", Some(panel_files(folder)), None, mount.clone()).unwrap();
        mount
    }
    struct Dir(PathBuf);
    impl Dir { fn new() -> Self { let path = std::env::temp_dir().join(format!("pandacode-rich-assets-test-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&path).unwrap(); Self(path) } }
    impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    #[test]
    fn origin_keys_are_per_package_stable_and_dns_safe() {
        let (alpha, twin) = (origin_key(ALPHA), origin_key(TWIN));
        assert_ne!(alpha, twin, "two packages never share an origin");
        assert_eq!(alpha, origin_key(ALPHA), "the same origin for every version and restart");
        for key in [&alpha, &twin] { assert_eq!(key.len(), 33); assert!(key.starts_with('p') && key.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())); }
        let url = shell_url(&alpha, "extension-panel-a");
        assert_eq!(parse(&url), Some((alpha.clone(), "/~panda/shell/extension-panel-a".into())));
        // Every form the engines hand over names the same key.
        for uri in [format!("http://pandapanel.{alpha}.localhost/x.js?y=1"), format!("https://pandapanel.{alpha}.localhost/x.js#f"), format!("pandapanel://{alpha}.localhost/x.js")] { assert_eq!(parse(&uri), Some((alpha.clone(), "/x.js".into())), "{uri}"); }
        for uri in ["http://pandapanel.localhost/x", "http://pandapanel.pzz.localhost/x", "https://example.com/x", "pandapanel://../x", "asset://localhost/x"] { assert_eq!(parse(uri), None, "{uri}"); }
        assert_ne!(origin(&alpha), "tauri://localhost"); assert!(!origin(&alpha).contains("127.0.0.1"));
    }

    #[test]
    fn sources_parse_three_forms_and_refuse_mixed_or_undeclared_origins() {
        assert_eq!(source(&json!({"html": "assets/a.html", "css": "assets/a.css", "script": "assets/a.js"})).unwrap(), None);
        assert_eq!(source(&board("alpha")["rich"]).unwrap(), Some(Source::Folder { folder: "panel".into(), entry: "index.html".into(), remote: vec!["https://charts.example.test".into()] }));
        let chart = manifest("alpha")["contributes"]["views"][1]["rich"].clone();
        assert_eq!(source(&chart).unwrap(), Some(Source::Remote { url: "https://charts.example.test/chart.html".into(), remote: vec!["https://charts.example.test".into()] }));
        for (bad, why) in [
            (json!({"html": "assets/a.html", "css": "assets/a.css", "script": "assets/a.js", "folder": "panel"}), "mixed"),
            (json!({"folder": "panel", "entry": "index.html", "url": "https://a.test/"}), "folder and url"),
            (json!({"folder": "Panel", "entry": "index.html"}), "folder case"),
            (json!({"folder": "panel", "entry": "../index.html"}), "dot-dot entry"),
            (json!({"folder": "panel", "entry": "/index.html"}), "absolute entry"),
            (json!({"folder": "panel", "entry": "a/./b.html"}), "dot segment"),
            (json!({"folder": "panel"}), "no entry"),
            (json!({"url": "http://charts.example.test/x", "remote": ["https://charts.example.test"]}), "http url"),
            (json!({"url": "https://charts.example.test/x"}), "no remote"),
            (json!({"url": "https://other.example.test/x", "remote": ["https://charts.example.test"]}), "unlisted origin"),
            (json!({"url": "https://Charts.example.test/x", "remote": ["https://charts.example.test"]}), "uppercase host"),
            (json!({"folder": "panel", "entry": "index.html", "remote": ["https://charts.example.test/path"]}), "origin with a path"),
            (json!({"folder": "panel", "entry": "index.html", "remote": []}), "empty remote"),
            (json!({"folder": "panel", "entry": "index.html", "remote": (0..17).map(|n| format!("https://h{n}.test")).collect::<Vec<_>>()}), "seventeen origins"),
            (json!({}), "empty"),
        ] { assert!(source(&bad).unwrap_err().starts_with("InvalidShape"), "{why}"); }
        for origin in ["https://a.test", "https://a.test:8443", "https://x-y.z.test"] { assert!(valid_origin(origin), "{origin}"); }
        for origin in ["http://a.test", "https://", "https://a.test:0", "https://a.test:99999", "https://.a.test", "https://a..test", "https://a.test/"] { assert!(!valid_origin(origin), "{origin}"); }
    }

    #[test]
    fn paths_resolve_inside_the_folder_and_everything_else_answers_a_useful_404() {
        assert_eq!(folder_path("/lib/format.js").as_deref(), Some("lib/format.js"));
        assert_eq!(folder_path("/img/logo%20mark.svg").as_deref(), Some("img/logo mark.svg"));
        assert_eq!(folder_path("/").as_deref(), Some("index.html"));
        assert_eq!(folder_path("/docs/").as_deref(), Some("docs/index.html"));
        for bad in ["/../extension.json", "/lib/../../main.cjs", "/%2e%2e/extension.json", "/a//b", "/a\\b", "/%zz", "/./a", "relative", "/a%00b"] { assert_eq!(folder_path(bad), None, "{bad}"); }
        let mut registry = Registry::default();
        let mount = mounted(&mut registry, "extension-panel-a", ALPHA, "alpha");
        let base = origin(&mount.key);
        let ok = registry.respond("extension-panel-a", "GET", &format!("{base}/lib/format.js"));
        assert_eq!((ok.status, ok.content_type), (200, "text/javascript; charset=utf-8"));
        for (path, expect) in [("/../extension.json", "Outside the panel folder"), ("/main.cjs", "Not in the panel folder"), ("/~panda/other", "Not a host file")] {
            let reply = registry.respond("extension-panel-a", "GET", &format!("{base}{path}"));
            assert_eq!(reply.status, 404, "{path}"); assert!(String::from_utf8_lossy(&reply.body).contains(expect), "{path}");
        }
        assert_eq!(registry.respond("extension-panel-a", "POST", &format!("{base}/index.html")).status, 405);
        assert!(registry.respond("extension-panel-a", "HEAD", &format!("{base}/index.html")).body.is_empty());
    }

    /// Q026 (changed part): package pages get no host content policy and module scripts their JavaScript type; the
    /// shell's own policy pins its frame to the package origin and `rich.remote`. The legacy composed document keeps
    /// its policy (`rich_views::tests`).
    #[test]
    fn package_files_carry_media_types_and_no_content_policy_while_the_shell_pins_frames_to_declared_origins() {
        let mut registry = Registry::default();
        let mount = mounted(&mut registry, "extension-panel-a", ALPHA, "alpha");
        let base = origin(&mount.key);
        for (path, media) in [("/app.js", "text/javascript; charset=utf-8"), ("/lib/format.js", "text/javascript; charset=utf-8"), ("/img/logo.svg", "image/svg+xml"), ("/styles.css", "text/css; charset=utf-8"), ("/index.html", "text/html; charset=utf-8")] {
            let reply = registry.respond("extension-panel-a", "GET", &format!("{base}{path}"));
            assert_eq!((reply.status, reply.content_type), (200, media), "{path}");
            assert!(!reply.headers.iter().any(|(name, _)| *name == "Content-Security-Policy"), "{path} has no host policy");
        }
        let shell = registry.respond("extension-panel-a", "GET", &shell_url(&mount.key, "extension-panel-a"));
        assert_eq!(shell.status, 200);
        let policy = &shell.headers.iter().find(|(name, _)| *name == "Content-Security-Policy").unwrap().1;
        assert!(policy.contains("frame-src 'self' https://charts.example.test;"), "{policy}");
        assert!(!policy.contains("unsafe-eval") && !policy.contains("blob:"));
        let html = String::from_utf8(shell.body).unwrap();
        assert!(html.contains("\"src\":\"/index.html\"") && html.contains("\"expectsClient\":true") && html.contains(&mount.session));
        assert!(!html.contains("sandbox"), "the entry keeps its origin so its storage is first-party");
        // A shell is served only to the webview it was composed for.
        assert_eq!(registry.respond("extension-panel-a", "GET", &shell_url(&mount.key, "extension-panel-b")).status, 404);
    }

    #[test]
    fn html_pages_receive_the_client_script_with_the_mount_session() {
        assert_eq!(String::from_utf8(inject_client(b"<!doctype html><html><HEAD><title>x</title></HEAD></html>", "s1")).unwrap(), "<!doctype html><html><HEAD><script src=\"/~panda/client.js\" data-panda-session=\"s1\"></script><title>x</title></HEAD></html>");
        assert!(String::from_utf8(inject_client(b"<html lang=\"en\"><body></body></html>", "s1")).unwrap().starts_with("<html lang=\"en\"><script src="));
        assert!(String::from_utf8(inject_client(b"<p>bare</p>", "s1")).unwrap().starts_with("<script src="));
        let mut registry = Registry::default();
        let mount = mounted(&mut registry, "extension-panel-a", ALPHA, "alpha");
        let page = registry.respond("extension-panel-a", "GET", &format!("{}/index.html", origin(&mount.key)));
        assert!(String::from_utf8(page.body).unwrap().contains(&format!("data-panda-session=\"{}\"", mount.session)));
        let client = registry.respond("extension-panel-a", "GET", &format!("{}/~panda/client.js", origin(&mount.key)));
        assert_eq!(client.content_type, "text/javascript; charset=utf-8");
        assert!(String::from_utf8(client.body).unwrap().contains("pandaView"));
    }

    /// The criterion's falsifier: two packages with the same storage key and the same relative paths get two
    /// origins, and neither is served the other's files; the app window is never served a package origin.
    #[test]
    fn two_packages_with_the_same_storage_key_get_distinct_origins_and_never_each_others_files() {
        let mut registry = Registry::default();
        let alpha = mounted(&mut registry, "extension-panel-a", ALPHA, "alpha");
        let twin = mounted(&mut registry, "extension-panel-b", TWIN, "twin");
        assert_ne!(origin(&alpha.key), origin(&twin.key));
        let own = |registry: &mut Registry, label: &str, key: &str| String::from_utf8(registry.respond(label, "GET", &format!("{}/app.js", origin(key))).body).unwrap();
        assert!(own(&mut registry, "extension-panel-a", &alpha.key).contains("STORAGE_KEY"));
        assert!(own(&mut registry, "extension-panel-b", &twin.key).contains("STORAGE_KEY"));
        // Both pages use the same key in their own storage (the fixtures' shared constant).
        assert!(std::fs::read_to_string(fixture("alpha").join("panel/app.js")).unwrap().contains("'panel-note'") && std::fs::read_to_string(fixture("twin").join("panel/app.js")).unwrap().contains("'panel-note'"));
        let foreign = registry.respond("extension-panel-a", "GET", &format!("{}/app.js", origin(&twin.key)));
        assert_eq!(foreign.status, 403); assert!(String::from_utf8_lossy(&foreign.body).contains("another package"));
        for label in ["main", "extension-panel-unknown", "agents-dock"] { assert_eq!(registry.respond(label, "GET", &format!("{}/index.html", origin(&alpha.key))).status, 403, "{label}"); }
        // A mount record cannot claim another package's origin.
        let mut forged = alpha.clone(); forged.key = twin.key.clone();
        assert_eq!(registry.admit("extension-panel-c", ALPHA, "generation-1", None, None, forged).unwrap_err(), "PermissionDenied");
    }

    /// Inspector panel and separate window of one package open the same origin, share one served folder, and a
    /// reopen after closing finds the same origin (so the page's own storage is there again).
    #[test]
    fn inspector_and_window_mounts_of_one_package_share_one_origin_and_survive_reopen() {
        let mut registry = Registry::default();
        let panel = mounted(&mut registry, "extension-panel-a", ALPHA, "alpha");
        let window = mounted(&mut registry, "extension-view-a", ALPHA, "alpha");
        assert_eq!(panel.key, window.key);
        assert_eq!(shell_url(&panel.key, "x").split("/~panda").next(), shell_url(&window.key, "y").split("/~panda").next());
        let held = registry.held_bytes();
        assert_eq!(held, panel_files("alpha").iter().map(|(_, bytes)| bytes.len() as u64).sum::<u64>(), "one folder for both mounts");
        registry.release("extension-panel-a");
        assert_eq!(registry.respond("extension-view-a", "GET", &format!("{}/index.html", origin(&window.key))).status, 200, "the window keeps the folder");
        registry.release("extension-view-a");
        assert_eq!(registry.held_bytes(), 0);
        let reopened = mounted(&mut registry, "extension-panel-z", ALPHA, "alpha");
        assert_eq!(origin(&reopened.key), origin(&panel.key));
        assert_ne!(reopened.session, panel.session, "a new document, the same origin");
    }

    #[test]
    fn the_asset_budget_refuses_with_a_useful_limit_and_release_frees_it() {
        assert_eq!(SERVED_BUDGET, 256 << 20);
        // The rule with a 4 MiB budget (the product's is 256 MiB; the rule is the same, the test stays small).
        let budget = 4 << 20; let half = (budget / 2) as usize;
        let mut registry = Registry::default();
        let mount = |owner: &str, label: &str| mount_for(owner, "1.0.0", &board("alpha"), &Source::Folder { folder: "panel".into(), entry: "index.html".into(), remote: vec![] }, label, false);
        registry.admit_within(budget, "extension-panel-1", "sample.big-one", "g", Some(vec![("index.html".into(), vec![b' '; half])]), None, mount("sample.big-one", "extension-panel-1")).unwrap();
        registry.admit_within(budget, "extension-panel-2", "sample.big-two", "g", Some(vec![("index.html".into(), vec![b' '; half])]), None, mount("sample.big-two", "extension-panel-2")).unwrap();
        let error = registry.admit_within(budget, "extension-panel-3", "sample.big-three", "g", Some(vec![("index.html".into(), vec![b' '; 1])]), None, mount("sample.big-three", "extension-panel-3")).unwrap_err();
        assert!(error.starts_with("LimitExceeded") && error.contains("4 MiB of panel assets") && error.contains("Close a panel of another package"), "{error}");
        // A second mount of a package already served costs nothing more.
        registry.admit_within(budget, "extension-view-2", "sample.big-two", "g", None, None, mount("sample.big-two", "extension-view-2")).unwrap();
        registry.release("extension-panel-1");
        registry.admit_within(budget, "extension-panel-3", "sample.big-three", "g", Some(vec![("index.html".into(), vec![b' '; 1])]), None, mount("sample.big-three", "extension-panel-3")).unwrap();
    }

    #[test]
    fn remove_own_data_requests_a_one_time_page_storage_wipe() {
        let dir = Dir::new();
        request_wipe(&dir.0, ALPHA).unwrap();
        let marker = wipe_marker(&dir.0, ALPHA);
        assert!(marker.is_file() && marker != wipe_marker(&dir.0, TWIN));
        let mut registry = Registry::default();
        let view = board("alpha"); let source = source(&view["rich"]).unwrap().unwrap();
        let mount = mount_for(ALPHA, "1.0.0", &view, &source, "extension-panel-a", false);
        registry.admit("extension-panel-a", ALPHA, "g", Some(panel_files("alpha")), Some(marker.clone()), mount.clone()).unwrap();
        let shell = String::from_utf8(registry.respond("extension-panel-a", "GET", &shell_url(&mount.key, "extension-panel-a")).body).unwrap();
        assert!(shell.contains("\"wipe\":true"));
        assert_eq!(registry.respond("extension-panel-a", "GET", &format!("{}/~panda/wiped", origin(&mount.key))).status, 204);
        assert!(!marker.exists());
        let again = String::from_utf8(registry.respond("extension-panel-a", "GET", &shell_url(&mount.key, "extension-panel-a")).body).unwrap();
        assert!(again.contains("\"wipe\":false"), "once");
    }

    /// Install of the fixtures through the real package validator: folders of any file type are declared panel
    /// files, a remote page needs a listed origin, and each failure says what is wrong. Q023 (changed part): the
    /// folder form is bounded only by the package limits, not by the legacy three-file budget.
    #[test]
    fn installed_folder_and_remote_panels_validate_and_bad_entries_or_origins_fail_with_useful_errors() {
        let dir = Dir::new();
        let packages = ExtensionPackages::new(&dir.0, false);
        let packages = packages.0.lock().unwrap();
        let mut alpha = files("alpha");
        // Larger than the legacy 64 KiB per file: a vendored module in the folder.
        alpha.push(("panel/lib/vendor.js".into(), format!("export const big = '{}';", "x".repeat(200 * 1024)).into_bytes()));
        packages.install(&archive(&alpha)).unwrap();
        packages.install(&archive(&files("twin"))).unwrap();
        let snapshot = packages.snapshot();
        let digest = |id: &str| snapshot.packages.iter().find(|package| package.manifest["id"] == id).unwrap().executable_digest().unwrap().to_owned();
        let generation = digest(ALPHA);
        assert_eq!(packages.panel_files(ALPHA, "panel").unwrap_err(), "PermissionDenied", "rich content waits for trust");
        packages.trust(ALPHA, &generation, true).unwrap(); packages.enable(ALPHA, true).unwrap();
        let (checksum, served) = packages.panel_files(ALPHA, "panel").unwrap();
        assert_eq!(checksum, generation);
        let names: Vec<&str> = served.iter().map(|(name, _)| name.as_str()).collect();
        for name in ["index.html", "app.js", "lib/format.js", "lib/vendor.js", "img/logo.svg", "styles.css"] { assert!(names.contains(&name), "{name}: {names:?}"); }
        let snapshot = packages.snapshot();
        let pinned = rich_views::pin(&snapshot, "sample.rich-assets/board", "1.0.0").unwrap();
        rich_views::pin(&snapshot, "sample.rich-assets/chart", "1.0.0").unwrap();
        assert_eq!(pinned.owner, ALPHA);
        packages.uninstall(TWIN).unwrap();

        let edit = |files: &[(String, Vec<u8>)], change: &dyn Fn(&mut Value)| -> Vec<u8> {
            let mut files = files.to_vec();
            let position = files.iter().position(|(name, _)| name == "extension.json").unwrap();
            let mut manifest: Value = serde_json::from_slice(&files[position].1).unwrap(); change(&mut manifest);
            files[position].1 = serde_json::to_vec(&manifest).unwrap(); archive(&files)
        };
        let twin = files("twin");
        let error = packages.install(&edit(&twin, &|manifest: &mut Value| manifest["contributes"]["views"][0]["rich"]["entry"] = json!("missing.html"))).unwrap_err();
        assert!(error.contains("entry page panel/missing.html is not in the archive"), "{error}");
        // Retained (predictability): a file outside every declared folder is still refused.
        let mut extra = twin.clone(); extra.push(("other/x.js".into(), b"x".to_vec()));
        assert!(packages.install(&archive(&extra)).unwrap_err().starts_with("Undeclared package file"));
        let error = packages.install(&edit(&twin, &|manifest: &mut Value| manifest["contributes"]["views"][0]["rich"] = json!({"url": "https://other.example.test/x", "remote": ["https://charts.example.test"]}))).unwrap_err();
        assert!(error.starts_with("Invalid manifest") || error.contains("not listed in rich.remote"), "{error}");
        let error = packages.install(&edit(&twin, &|manifest: &mut Value| manifest["contributes"]["views"][0]["rich"]["html"] = json!("assets/x.html"))).unwrap_err();
        assert!(error.starts_with("Invalid manifest") || error.contains("never a mix"), "{error}");
        // Retained (unauthorized): without ui.richViews the package does not validate.
        let error = packages.install(&edit(&twin, &|manifest: &mut Value| manifest["permissions"] = json!(["ui.contribute"]))).unwrap_err();
        assert!(error.starts_with("Invalid manifest"), "{error}");
    }

    /// Update behaviour: a new archive generation keeps the origin (and so the page's storage) and ends a live
    /// panel of the previous generation as `changed`.
    #[test]
    fn an_update_keeps_the_origin_and_ends_panels_of_the_previous_generation() {
        let dir = Dir::new();
        let packages = ExtensionPackages::new(&dir.0, false);
        let packages = packages.0.lock().unwrap();
        packages.install(&archive(&files("alpha"))).unwrap();
        let digest = packages.snapshot().packages[0].executable_digest().unwrap().to_owned();
        packages.trust(ALPHA, &digest, true).unwrap(); packages.enable(ALPHA, true).unwrap();
        let before = rich_views::pin(&packages.snapshot(), "sample.rich-assets/board", "1.0.0").unwrap();
        let changed: Vec<(String, Vec<u8>)> = files("alpha").into_iter().map(|(name, bytes)| if name == "panel/lib/format.js" { (name, b"export const format = value => `v2 ${value}`;".to_vec()) } else { (name, bytes) }).collect();
        let staged = dir.0.join("update.zip"); std::fs::write(&staged, archive(&changed)).unwrap();
        packages.uninstall(ALPHA).unwrap();
        packages.install(&std::fs::read(&staged).unwrap()).unwrap();
        let next = packages.snapshot().packages[0].executable_digest().unwrap().to_owned();
        packages.trust(ALPHA, &next, true).unwrap(); packages.enable(ALPHA, true).unwrap();
        let after = rich_views::pin(&packages.snapshot(), "sample.rich-assets/board", "1.0.0").unwrap();
        assert_ne!(before.fingerprint, after.fingerprint, "a live panel of the previous archive ends as changed");
        assert_eq!(origin_key(&before.owner), origin_key(&after.owner), "the origin and its storage stay");
    }
}
