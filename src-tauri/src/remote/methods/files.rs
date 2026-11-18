//! PandaConnect methods for the `files` feature group: the computer's projects, a file browser
//! over a project's (or a task's) checkout, and `files.write` (Full) to save one text file. See `methods/mod.rs`
//! and docs/remote-access.md, "Adding a method".
//!
//! Every path goes through `path_param` (relative, no `..`, no `.git`) and then the desktop's
//! own `workspace` readers, which resolve symlinks and refuse anything outside the root. A
//! symlink inside the root that resolves into a `.git` folder is refused too ([`into_git`]).
//!
//! `files.read` text pages carry the whole file's `hash`; `files.write` saves only when its
//! `baseHash` still matches the file on disk, else it answers [`WRITE_CONFLICT`].
use super::{id_param, path_param, task_root, Access, Ctx, Method, Reply, Run, PAGE_BUDGET};
use crate::{AppState, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;

/// Projects one `projects.list` returns; the desktop sidebar is far smaller in practice.
const MAX_PROJECTS: usize = 300;
/// Text bytes one `files.read` page carries before JSON escaping.
const READ_CHUNK: usize = 96 * 1024;
/// Base64 characters one `files.image` (and progress media) page carries; a multiple of 4.
pub(crate) const DATA_CHUNK: usize = 160 * 1024;
/// Filename hits one `files.search` returns.
const MAX_SEARCH: usize = 200;
/// Files and lines one `files.grep` returns.
const MAX_GREP_FILES: usize = 100;
const MAX_GREP_LINES: usize = 500;
/// The desktop's search limit for queries.
const MAX_QUERY: usize = 512;
const IMAGE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
/// Files that commonly hold credentials, as lowercase name patterns (`*` matches any run of
/// characters). Below Full access a phone may see their names in `files.list` but cannot
/// read them, and `files.search`/`files.grep` leave them out.
const SECRET_FILES: &[&str] = &[
    ".env", ".env.*", ".envrc", ".dev.vars", "*.pem", "*.key", "id_rsa*", "id_ed25519*", "id_ecdsa*", "id_dsa*", ".npmrc", ".netrc", ".pypirc", "credentials", "credentials*.json", ".git-credentials", ".pgpass",
    "*.tfvars", "terraform.tfstate*", ".htpasswd", "*.p12", "*.pfx", "*.keystore", "*.jks", "kubeconfig", ".yarnrc.yml",
    "application_default_credentials.json", "*-credentials.json", "service-account*.json", "service_account*.json",
    ".vault-token", ".s3cfg", ".boto", "auth.json", "*.ovpn",
    // Round 11: MCP server configs carry tokens in `env`/headers; secrets files by convention.
    ".mcp.json", "secrets.*",
    // Round 12: env files named for their stage, and Firebase/GCP service-account keys.
    "*.env", "serviceaccountkey.json", "firebase-adminsdk*.json", "*-service-account*.json",
    // Round 16: PandaConnect's own secrets and grants, dot-credentials, signing and PuTTY keys,
    // GPG files and tool login configs.
    "connect-secrets.json", "connect-grants.json", ".credentials.json", "credentials.toml", "*.p8", "*.ppk", "*.gpg", ".terraformrc",
    // Round 17: Claude Code's user config (MCP servers with tokens) and shell/REPL histories,
    // which keep pasted tokens and `export KEY=...` lines.
    ".claude.json", ".zsh_history", ".bash_history", ".python_history",
    // Round 20: Gradle/Yarn/pip/rclone tokens, KeePass databases and the legacy Docker login.
    "gradle.properties", ".yarnrc", "pip.conf", "rclone.conf", "*.kdbx", ".dockercfg",
    // Round 22: more shell/REPL/database client histories and the ngrok agent config (authtoken).
    "fish_history", ".psql_history", ".mysql_history", ".node_repl_history", ".sqlite_history", ".irb_history", "ngrok.yml",
];
/// Files that hold credentials only in a known folder, as lowercase path endings
/// (`folder/name`, or more folders). Round 17: MCP server configs under each editor's or
/// agent's own name.
const SECRET_PATHS: &[&str] = &[
    ".kube/config", ".docker/config.json", "gh/hosts.yml", ".aws/config", ".claude/settings.local.json",
    ".cursor/mcp.json", ".vscode/mcp.json", ".roo/mcp.json", ".gemini/settings.json", ".codex/config.toml",
    // Round 20: Maven's server passwords and the `hub` CLI's GitHub token.
    ".m2/settings.xml", ".config/hub",
    // Round 21: Gemini and Qwen CLI logins, Azure's token cache, GitHub Copilot's app tokens,
    // and the Netlify and Cloudflare Wrangler CLI logins.
    ".gemini/oauth_creds.json", ".qwen/oauth_creds.json", ".azure/msal_token_cache.json", "github-copilot/apps.json", ".netlify/config.json",
    ".wrangler/config/default.toml",
    // Round 22: Hugging Face, GitHub Copilot, Firebase, Stripe and Fly.io CLI logins.
    ".huggingface/token", "huggingface/token", ".config/github-copilot/hosts.json", "configstore/firebase-tools.json", ".config/stripe/config.toml",
    ".fly/config.yml",
];
/// Round 21: a file name that is a secret anywhere below a folder sequence: gcloud's legacy
/// per-account credentials (`gcloud/legacy_credentials/<account>/adc.json`).
const SECRET_BELOW: &[(&[&str], &str)] = &[(&["gcloud", "legacy_credentials"], "adc.json")];
/// Folders whose every file is treated as a secret, wherever they sit in the path.
const SECRET_FOLDERS: &[&str] = &[".ssh", ".gnupg"];
/// A Full-scope method: a grant check against it tells whether the calling device has Full.
const FULL_PROBE: &str = "terminal.open";
/// Largest text `files.write` saves: a request frame is 256 KiB sealed, and escaping can double text.
pub(crate) const WRITE_LIMIT: usize = 64 * 1024;
/// The distinct error a stale `files.write` gets; the phone matches its start.
pub(crate) const WRITE_CONFLICT: &str = "Changed on the computer since you opened it.";
/// Why a write into a checkout with a running agent is refused.
const WRITE_RUNNING: &str = "An agent is working in this checkout. Wait for it to finish, then save.";
/// Why a secret file is refused.
pub(crate) const SECRET_REFUSED: &str = "This file may hold secrets. Give this phone Full access on the computer to open it.";
/// Round 22: why a project rooted at `/`, the home folder or one of its ancestors is refused to
/// a device below Full (its files would be the whole home folder: keys, configs, histories).
pub(crate) const HOME_ROOT_REFUSED: &str = "This project is your home folder; open files from it on this computer.";
/// Round 23: why a project that is, holds or sits inside PandaCode's app data folder (the
/// database, secrets file, attachments) is refused below Full.
pub(crate) const APP_DATA_ROOT_REFUSED: &str = "This project holds PandaCode's own data; open files from it on this computer.";
/// Why a hard-linked file is refused: its other name may be anywhere (`~/.ssh/id_rsa`), out of
/// reach of the secret-name and symlink checks.
pub(crate) const HARD_LINK_REFUSED: &str = crate::workspace::HARD_LINK_REFUSED;

/// Where a call reads: a registered project's main checkout, or a task's own checkout.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Target {
    Project(String),
    Task(String),
}

/// `sessionId` (a task's checkout) wins over `projectId`; one of them is required.
pub(crate) fn target_param(params: &Value) -> Result<Target> {
    if params.get("sessionId").is_some_and(|v| !v.is_null()) {
        return Ok(Target::Task(id_param(params, "sessionId")?));
    }
    if params.get("projectId").is_some_and(|v| !v.is_null()) {
        return Ok(Target::Project(id_param(params, "projectId")?));
    }
    Err("Choose a project or a task.".into())
}

/// The target's project id and checkout. Bot workspaces and mirrored tasks are refused.
pub(crate) async fn resolve(state: &AppState, target: &Target) -> Result<(String, PathBuf)> {
    match target {
        Target::Task(session_id) => {
            // Round 19: a bot task's workspace is refused by `sessionId` as by `projectId`.
            let task = super::super::host::workspace_task(state, session_id).await?;
            Ok((task.project_id, task_root(state, session_id).await?))
        }
        Target::Project(project_id) => {
            let store = state.store.clone();
            let project_id = project_id.clone();
            crate::blocking(move || {
                let store = store.lock().map_err(|e| e.to_string())?;
                if crate::bots::project_ids(&store)?.contains(&project_id) {
                    return Err("That project belongs to a bot.".into());
                }
                let root = store.workspace_root(&project_id, None)?;
                Ok((project_id, root))
            })
            .await
        }
    }
}

/// A search query: 1 to 512 bytes, no NUL (the desktop's own bounds).
pub(crate) fn query_param(params: &Value) -> Result<String> {
    let query = params.get("query").and_then(Value::as_str).unwrap_or_default();
    if query.trim().is_empty() || query.len() > MAX_QUERY || query.contains('\0') {
        return Err("Search for 1 to 512 characters.".into());
    }
    Ok(query.to_owned())
}

pub(crate) fn offset_param(params: &Value) -> Result<usize> {
    match params.get("offset").filter(|v| !v.is_null()) {
        None => Ok(0),
        Some(value) => value.as_u64().and_then(|n| usize::try_from(n).ok()).ok_or_else(|| "Invalid offset.".into()),
    }
}

fn flag_param(params: &Value, key: &str) -> Result<bool> {
    match params.get(key).filter(|v| !v.is_null()) {
        None => Ok(false),
        Some(value) => value.as_bool().ok_or_else(|| format!("Invalid {key}.")),
    }
}

/// A `data:<mime>;base64,<data>` URL split into its parts.
pub(crate) fn split_data_url(url: &str) -> Result<(&str, &str)> {
    let rest = url.strip_prefix("data:").ok_or("Invalid image.")?;
    let (mime, data) = rest.split_once(";base64,").ok_or("Invalid image.")?;
    Ok((mime, data))
}

/// One page of a base64 payload: `{mime, total, offset, data, done}`.
pub(crate) fn data_page(mime: &str, data: &str, offset: usize) -> Result<Value> {
    if offset > data.len() || !offset.is_multiple_of(4) {
        return Err("Invalid offset.".into());
    }
    let end = (offset + DATA_CHUNK).min(data.len());
    Ok(json!({"mime": mime, "total": data.len(), "offset": offset, "data": &data[offset..end], "done": end == data.len()}))
}

/// One page of text from `offset` (bytes): ends on a line break when one is near, never mid-character,
/// and shrinks until its JSON fits [`PAGE_BUDGET`].
pub(crate) fn text_page(text: &str, offset: usize, chunk: usize) -> Result<Value> {
    if offset > text.len() || !text.is_char_boundary(offset) {
        return Err("Invalid offset.".into());
    }
    let mut size = chunk.max(1024);
    loop {
        let mut end = (offset + size).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        if end < text.len() {
            if let Some(newline) = text[offset..end].rfind('\n').filter(|at| *at > 0) {
                end = offset + newline + 1;
            }
        }
        let page = json!({"kind": "text", "text": &text[offset..end], "offset": offset, "total": text.len(), "done": end == text.len()});
        if page.to_string().len() <= PAGE_BUDGET || size <= 1024 {
            return Ok(page);
        }
        size /= 2;
    }
}

/// What `files.read` says instead of text for a file it cannot show as text.
fn unreadable(path: &str, error: &str) -> Option<Value> {
    let kind = if error.starts_with("Binary files") || error.starts_with("File is not UTF-8") {
        "binary"
    } else if error.starts_with("File exceeds") {
        "tooLarge"
    } else {
        return None;
    };
    Some(json!({"kind": kind, "path": path, "message": error}))
}

fn is_image(path: &str) -> bool {
    Path::new(path).extension().and_then(|e| e.to_str()).is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Whether `pattern` (lowercase, `*` for any run of characters) matches all of `name`.
fn glob_match(pattern: &str, name: &str) -> bool {
    let mut parts = pattern.split('*');
    let first = parts.next().unwrap_or_default();
    let Some(mut rest) = name.strip_prefix(first) else { return false };
    let parts: Vec<&str> = parts.collect();
    let Some((last, middle)) = parts.split_last() else { return rest.is_empty() };
    for part in middle {
        let Some(at) = rest.find(part) else { return false };
        rest = &rest[at + part.len()..];
    }
    rest.len() >= last.len() && rest.ends_with(last)
}

/// Whether a file name is one of the [`SECRET_FILES`].
pub(crate) fn is_secret_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    SECRET_FILES.iter().any(|pattern| glob_match(pattern, &name))
}

/// Whether a path names a secret file: by its name ([`SECRET_FILES`]), by its folder and
/// name ([`SECRET_PATHS`]), or by lying under a [`SECRET_FOLDERS`] folder.
pub(crate) fn is_secret_path(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str());
    if name.is_some_and(is_secret_name) {
        return true;
    }
    let under_secret_folder = path
        .parent()
        .is_some_and(|parent| parent.components().any(|part| part.as_os_str().to_str().is_some_and(|part| SECRET_FOLDERS.iter().any(|folder| part.eq_ignore_ascii_case(folder)))));
    if under_secret_folder {
        return true;
    }
    let parts: Vec<String> = path.components().filter_map(|part| part.as_os_str().to_str()).map(str::to_ascii_lowercase).collect();
    let joined = parts.join("/");
    let tail_matches = |pattern: &str| joined == pattern || joined.strip_suffix(pattern).is_some_and(|head| head.ends_with('/'));
    if SECRET_PATHS.iter().any(|pattern| tail_matches(pattern)) {
        return true;
    }
    let Some((name, folders)) = parts.split_last() else { return false };
    SECRET_BELOW.iter().any(|(below, file)| name == file && folders.windows(below.len()).any(|window| window.iter().zip(below.iter()).all(|(part, want)| part == want)))
}

/// Whether `path` under `root` names a secret file, or is a symlink that resolves to one.
fn is_secret(root: &Path, path: &str) -> bool {
    is_secret_path(Path::new(path)) || root.join(path).canonicalize().is_ok_and(|resolved| is_secret_path(&resolved))
}

/// Whether `root` is the file system root, `home`, or a folder that contains `home`. Both are
/// compared as given and canonicalized, so a symlinked or `..`-spelled root is caught too.
pub(crate) fn exposes_home(root: &Path, home: Option<&Path>) -> bool {
    let roots = path_forms(root);
    if roots.iter().any(|root| root.parent().is_none()) {
        return true;
    }
    let Some(home) = home.filter(|home| !home.as_os_str().is_empty()) else { return false };
    let homes = path_forms(home);
    roots.iter().any(|root| homes.iter().any(|home| home.starts_with(root)))
}

/// A path as given and, when it resolves, canonicalized (symlinks, `..`).
fn path_forms(path: &Path) -> Vec<PathBuf> {
    let mut forms = vec![path.to_path_buf()];
    if let Ok(resolved) = path.canonicalize() {
        forms.push(resolved);
    }
    forms
}

/// Round 23: whether `root` is, contains or sits inside the app data folder `data`
/// (`secret_store::dir()`, set at startup from Tauri's `app_data_dir`), in either spelling.
pub(crate) fn touches_app_data(root: &Path, data: Option<&Path>) -> bool {
    let Some(data) = data.filter(|data| !data.as_os_str().is_empty()) else { return false };
    let roots = path_forms(root);
    let datas = path_forms(data);
    roots.iter().any(|root| datas.iter().any(|data| data.starts_with(root) || root.starts_with(data)))
}

/// The user's home folder (`HOME`), when set.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").filter(|home| !home.is_empty()).map(PathBuf::from)
}

/// Round 22: refuses a checkout that [`exposes_home`] to a device below Full, for `files.*`,
/// `task.diff`, `turn.diff` and `task.workspaceImage`. Touches the file system (canonicalize),
/// so callers run it inside `blocking`.
pub(crate) fn allow_root(root: &Path, full: bool) -> Result<()> {
    if !full && exposes_home(root, home_dir().as_deref()) {
        return Err(HOME_ROOT_REFUSED.into());
    }
    if !full && touches_app_data(root, crate::secret_store::dir()) {
        return Err(APP_DATA_ROOT_REFUSED.into());
    }
    Ok(())
}

/// Whether the calling device has Full scope (Ctx carries only the host's setting).
pub(crate) fn device_has_full(ctx: &Ctx<'_>) -> bool {
    device_from_has_full(ctx.app, ctx.from)
}

/// `device_has_full` for callers outside the method table (`host.rs`), which hold `app` and `from`.
pub(crate) fn device_from_has_full(app: &tauri::AppHandle, from: &str) -> bool {
    super::super::grants::check(app, from, FULL_PROBE).is_ok()
}

/// Refuses a secret file to a device below Full.
fn allow_secret(root: &Path, path: &str, full: bool) -> Result<()> {
    if !full && is_secret(root, path) {
        return Err(SECRET_REFUSED.into());
    }
    Ok(())
}

/// Round 12: refuses a regular file under `root` with more than one hard link, to every device,
/// for `files.read`, `files.image` and `files.write`. Follows symlinks (their target is what
/// would be read); a missing file is left to the readers' own errors.
/// The check itself is `workspace::hard_linked`, shared with the phone's diffs.
fn refuse_hard_link(root: &Path, path: &str) -> Result<()> {
    if crate::workspace::hard_linked(&root.join(path)) {
        return Err(HARD_LINK_REFUSED.into());
    }
    Ok(())
}

/// Keeps the first `max_lines` matching lines across at most `max_files` files of a
/// serialized `TextSearchResult` (`{files: [{path, matches}], truncated}`).
fn bound_grep(result: Value, max_files: usize, max_lines: usize) -> Value {
    let mut truncated = result["truncated"].as_bool().unwrap_or(false);
    let mut lines = 0;
    let mut files = Vec::new();
    for file in result["files"].as_array().map(Vec::as_slice).unwrap_or_default() {
        if files.len() >= max_files || lines >= max_lines {
            truncated = true;
            break;
        }
        let matches = file["matches"].as_array().map(Vec::as_slice).unwrap_or_default();
        let keep = matches.len().min(max_lines - lines);
        truncated |= keep < matches.len();
        lines += keep;
        files.push(json!({"path": file["path"], "matches": &matches[..keep]}));
    }
    while json!({"files": files}).to_string().len() > PAGE_BUDGET - 1024 && !files.is_empty() {
        files.pop();
        truncated = true;
    }
    json!({"files": files, "truncated": truncated})
}

/// A project's path as the phone shows it: `~/…` below the home folder, else only the folder's
/// name (Round 20), so a checkout elsewhere (`/Volumes/<name>/…`) names no local path.
fn display_path(path: &str) -> String {
    let home = std::env::var("HOME").ok().filter(|h| !h.is_empty());
    match home.as_deref().and_then(|home| path.strip_prefix(home)) {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("~{rest}"),
        _ => Path::new(path).file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
    }
}

// ---- projects.list ----

#[derive(Debug)]
struct Projects;

impl Run for Projects {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let store = ctx.state().store.clone();
            crate::blocking(move || {
                let (rows, bots) = {
                    let store = store.lock().map_err(|e| e.to_string())?;
                    (store.projects()?, crate::bots::project_ids(&store)?.into_iter().collect::<HashSet<_>>())
                };
                let projects: Vec<Value> = rows
                    .into_iter()
                    .filter(|project| !bots.contains(&project.id))
                    .take(MAX_PROJECTS)
                    .map(|project| {
                        let root = Path::new(&project.path);
                        json!({
                            "id": project.id,
                            "name": project.name,
                            "path": display_path(&project.path),
                            "repo": crate::github_hub::project_repo(root),
                            "chat": crate::chats::is_chat_folder(root),
                            "addedOrder": project.added_order,
                        })
                    })
                    .collect();
                Ok(json!({"projects": projects}))
            })
            .await
        })
    }
}

// ---- files.list ----

#[derive(Debug, PartialEq)]
struct List {
    target: Target,
    path: Option<String>,
}

impl Run for List {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (_, root) = resolve(&ctx.state(), &self.target).await?;
            let full = device_has_full(&ctx);
            let path = self.path;
            crate::blocking(move || {
                allow_root(&root, full)?;
                if let Some(path) = &path {
                    outside_git(&root, path)?;
                }
                let entries = crate::workspace::list_files(&root, path.clone())?;
                let truncated = entries.len() >= 500;
                let entries: Vec<Value> = entries.into_iter().filter(|e| !into_git(&root, &e.path)).map(|e| json!({"name": e.name, "path": e.path, "dir": e.is_dir})).collect();
                Ok(json!({"path": path.unwrap_or_default(), "entries": entries, "truncated": truncated}))
            })
            .await
        })
    }
}

// ---- files.read ----

#[derive(Debug, PartialEq)]
struct Read {
    target: Target,
    path: String,
    offset: usize,
}

impl Run for Read {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (_, root) = resolve(&ctx.state(), &self.target).await?;
            let full = device_has_full(&ctx);
            let (path, offset) = (self.path, self.offset);
            crate::blocking(move || {
                allow_root(&root, full)?;
                outside_git(&root, &path)?;
                allow_secret(&root, &path, full)?;
                refuse_hard_link(&root, &path)?;
                if is_image(&path) {
                    return Ok(json!({"kind": "image", "path": path}));
                }
                read_page(&root, path, offset, full)
            })
            .await
        })
    }
}

fn read_page(root: &Path, path: String, offset: usize, full: bool) -> Result<Value> {
    match read_text_checked(root, &path, full) {
        Ok(text) => {
            let mut page = text_page(&text, offset, READ_CHUNK)?;
            page["path"] = json!(path);
            page["hash"] = json!(content_hash(&text));
            Ok(page)
        }
        Err(error) => unreadable(&path, &error).ok_or(error),
    }
}

// ---- files.image ----

#[derive(Debug, PartialEq)]
struct Image {
    target: Target,
    path: String,
    offset: usize,
}

impl Run for Image {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (_, root) = resolve(&ctx.state(), &self.target).await?;
            let full = device_has_full(&ctx);
            let (path, offset) = (self.path, self.offset);
            crate::blocking(move || {
                let url = checked_image_data_url(&root, &path, full)?;
                let (mime, data) = split_data_url(&url)?;
                data_page(mime, data, offset)
            })
            .await
        })
    }
}

/// The one way PandaConnect reads a workspace image (`files.image`, `task.workspaceImage`):
/// refuses a path that resolves into `.git`, a secret file (or a symlink to one) to a device
/// below Full, and a hard-linked file to every device, before reading. The `full` variant hands
/// back the raw bytes, so a `logo.png -> .env` symlink must never get this far.
pub(crate) fn checked_image_data_url(root: &Path, path: &str, device_has_full: bool) -> Result<String> {
    allow_root(root, device_has_full)?;
    outside_git(root, path)?;
    allow_secret(root, path, device_has_full)?;
    refuse_hard_link(root, path)?;
    image_data_url_checked(root, path, device_has_full)
}

// ---- handle-checked reads ----

/// Same limits and messages as the desktop's `workspace::read_file` and `image_data_url`.
const TEXT_LIMIT: u64 = 128 * 1024;
const TEXT_NOT_REGULAR: &str = "Only regular text files can be previewed";
const TEXT_TOO_LARGE: &str = "File exceeds the 128 KiB preview limit";
const IMAGE_LIMIT: u64 = 8 * 1024 * 1024;
const IMAGE_UNAVAILABLE: &str = "The image is missing or larger than 8 MB";
/// Why a read is refused when the file changed between the checks and the open.
const FILE_CHANGED: &str = "This file changed while it was being opened. Try again.";

/// Round 16: opens `path` under `root` once for a remote read and checks the handle, so the
/// file cannot be swapped (for a symlink, a hard link or another file) between the path checks
/// and the read. The path resolves once to its canonical target, which must stay inside the
/// canonical root, out of `.git` and (below Full) off the secret list; that target is opened without following a symlink at its
/// last component, and the handle must be a regular file with one link whose device and inode
/// match the target stat'ed beforehand. Returns the canonical target and the open file.
fn open_checked(root: &Path, path: &str, full: bool, not_regular: &str) -> Result<(PathBuf, std::fs::File)> {
    let base = root.canonicalize().map_err(|e| e.to_string())?;
    let target = root.join(path).canonicalize().map_err(|e| e.to_string())?;
    let inside = target.strip_prefix(&base).map_err(|_| "Symlink points outside the project")?;
    if inside.components().any(|part| part.as_os_str().to_str().is_some_and(|name| name.eq_ignore_ascii_case(".git"))) {
        return Err("That file is not available.".into());
    }
    if !full && (is_secret_path(Path::new(path)) || is_secret_path(&target)) {
        return Err(SECRET_REFUSED.into());
    }
    // Before opening: opening a FIFO blocks until a writer appears, and a device never ends.
    let checked = std::fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
    if !checked.is_file() {
        return Err(not_regular.into());
    }
    if link_count(&checked) > 1 {
        return Err(HARD_LINK_REFUSED.into());
    }
    let file = open_no_follow(&target).map_err(|_| FILE_CHANGED.to_owned())?;
    let opened = file.metadata().map_err(|e| e.to_string())?;
    if !opened.is_file() {
        return Err(not_regular.into());
    }
    if link_count(&opened) > 1 {
        return Err(HARD_LINK_REFUSED.into());
    }
    if !same_file(&opened, &checked) {
        return Err(FILE_CHANGED.into());
    }
    Ok((target, file))
}

/// Opens without following a symlink at the last component, and without blocking on a FIFO.
fn open_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path)
    }
    #[cfg(not(unix))]
    {
        if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
            return Err(std::io::ErrorKind::InvalidInput.into());
        }
        std::fs::File::open(path)
    }
}

#[cfg(unix)]
fn link_count(meta: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    meta.nlink()
}
#[cfg(not(unix))]
fn link_count(_meta: &std::fs::Metadata) -> u64 {
    1
}

#[cfg(unix)]
fn same_file(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino()
}
#[cfg(not(unix))]
fn same_file(_a: &std::fs::Metadata, _b: &std::fs::Metadata) -> bool {
    true
}

/// Reads up to `limit` bytes from the handle; None when the file is (or grew) larger.
fn read_bounded(file: std::fs::File, limit: u64) -> Result<Option<Vec<u8>>> {
    use std::io::Read as _;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok((bytes.len() as u64 <= limit).then_some(bytes))
}

/// `files.read`'s text, from the checked handle, with `workspace::read_file`'s rules.
fn read_text_checked(root: &Path, path: &str, full: bool) -> Result<String> {
    let (_, file) = open_checked(root, path, full, TEXT_NOT_REGULAR)?;
    if file.metadata().map_err(|e| e.to_string())?.len() > TEXT_LIMIT {
        return Err(TEXT_TOO_LARGE.into());
    }
    let bytes = read_bounded(file, TEXT_LIMIT)?.ok_or(TEXT_TOO_LARGE)?;
    if bytes.contains(&0) {
        return Err("Binary files cannot be previewed as text".into());
    }
    String::from_utf8(bytes).map_err(|_| "File is not UTF-8 text".into())
}

/// A workspace image as a `data:` URL, from the checked handle, with `workspace::image_data_url`'s
/// type and size rules (the type comes from the resolved file's extension).
fn image_data_url_checked(root: &Path, path: &str, full: bool) -> Result<String> {
    use base64::Engine;
    let target = root.join(path).canonicalize().map_err(|e| e.to_string())?;
    let mime = image_mime(&target)?;
    let (opened, file) = open_checked(root, path, full, IMAGE_UNAVAILABLE)?;
    if opened != target {
        return Err(FILE_CHANGED.into());
    }
    if file.metadata().map_err(|e| e.to_string())?.len() > IMAGE_LIMIT {
        return Err(IMAGE_UNAVAILABLE.into());
    }
    let bytes = read_bounded(file, IMAGE_LIMIT)?.ok_or(IMAGE_UNAVAILABLE)?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

fn image_mime(target: &Path) -> Result<&'static str> {
    Ok(match target.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        _ => return Err("Only PNG, JPEG, GIF, WebP and SVG images can be shown".into()),
    })
}

// ---- files.search / files.grep ----

#[derive(Debug, PartialEq)]
struct Search {
    target: Target,
    query: String,
}

impl Run for Search {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (_, root) = resolve(&ctx.state(), &self.target).await?;
            let full = device_has_full(&ctx);
            let query = self.query;
            crate::blocking(move || {
                allow_root(&root, full)?;
                let entries = crate::workspace::search_files(&root, query, Some(MAX_SEARCH))?;
                let shown = |path: &str| !into_git(&root, path) && (full || !is_secret(&root, path));
                let entries: Vec<Value> = entries.into_iter().filter(|e| shown(&e.path)).take(MAX_SEARCH).map(|e| json!({"name": e.name, "path": e.path, "dir": e.is_dir})).collect();
                Ok(json!({"entries": entries}))
            })
            .await
        })
    }
}

#[derive(Debug, PartialEq)]
struct Grep {
    target: Target,
    query: String,
    match_case: bool,
    whole_word: bool,
    regex: bool,
}

impl Run for Grep {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (_, root) = resolve(&ctx.state(), &self.target).await?;
            let full = device_has_full(&ctx);
            let Grep { query, match_case, whole_word, regex, .. } = *self;
            crate::blocking(move || {
                allow_root(&root, full)?;
                // Hard-linked files are never read for a phone, as `files.read` refuses them.
                let result = crate::workspace::search_text_for_phone(&root, &query, match_case, whole_word, regex)?;
                let mut result = serde_json::to_value(result).map_err(|e| e.to_string())?;
                if let Some(files) = result["files"].as_array_mut() {
                    let hidden = |path: &str| into_git(&root, path) || (!full && is_secret(&root, path));
                    files.retain(|file| !file["path"].as_str().is_some_and(hidden));
                }
                Ok(bound_grep(result, MAX_GREP_FILES, MAX_GREP_LINES))
            })
            .await
        })
    }
}

// ---- files.write ----

/// Lowercase hex SHA-256 of a file's text: the version `files.read` reports and `files.write` checks.
pub(crate) fn content_hash(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, PartialEq)]
struct Write {
    target: Target,
    path: String,
    text: String,
    base_hash: String,
}

impl Run for Write {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            // Saving can plant hooks (`.claude/settings.json`, `.husky/*`) that run later as the
            // user, so it needs the host's Full access like a shell does.
            super::terminal::require_full_access_to(ctx.full_access, super::terminal::EDIT_FILES)?;
            let (_, root) = resolve(&ctx.state(), &self.target).await?;
            refuse_running_in(&ctx, &root).await?;
            let full = device_has_full(&ctx);
            let Write { path, text, base_hash, .. } = *self;
            let reply = crate::blocking(move || {
                allow_secret(&root, &path, full)?;
                write_text(&root, &path, &text, &base_hash)
            })
            .await?;
            use tauri::Emitter as _;
            let _ = ctx.app.emit("sessions-changed", ());
            Ok(reply)
        })
    }
}

/// Refuses while an agent runs in `root`: a task's worktree, or a main checkout a task works in.
async fn refuse_running_in(ctx: &Ctx<'_>, root: &Path) -> Result<()> {
    if running_in(ctx, root).await? {
        return Err(WRITE_RUNNING.into());
    }
    Ok(())
}

/// Whether an agent runs in `root`, literally or canonically (`git.discard` asks too).
pub(super) async fn running_in(ctx: &Ctx<'_>, root: &Path) -> Result<bool> {
    let state = ctx.state();
    let running: Vec<String> = crate::run_requests::lock_agents(&state.agents).map_err(|e| e.to_string())?.keys().cloned().collect();
    let mut others = Vec::with_capacity(running.len());
    for session_id in running {
        if let Ok(other) = task_root(&state, &session_id).await {
            others.push(other);
        }
    }
    // Canonicalizing touches the file system (a slow or network volume can stall), so off the runtime.
    let root = root.to_path_buf();
    crate::blocking(move || Ok(any_same_checkout(&root, &others))).await
}

/// Whether any of `others` is `root`, literally or once both are canonical.
fn any_same_checkout(root: &Path, others: &[PathBuf]) -> bool {
    let canonical = std::cell::OnceCell::new();
    others.iter().any(|other| other == root || other.canonicalize().ok().is_some_and(|a| canonical.get_or_init(|| root.canonicalize().ok()).as_ref() == Some(&a)))
}

/// Saves `text` over an existing text file under `root` when it still hashes to `base_hash`.
/// Writes go one at a time, through a temporary sibling renamed over the file (keeping its mode).
fn write_text(root: &Path, path: &str, text: &str, base_hash: &str) -> Result<Value> {
    static WRITES: StdMutex<()> = StdMutex::new(());
    let _one = WRITES.lock().map_err(|e| e.to_string())?;
    outside_git(root, path)?;
    refuse_hard_link(root, path)?;
    let current = crate::workspace::read_file(root, path.to_owned()).map_err(|error| match unreadable(path, &error) {
        Some(_) if error.starts_with("File exceeds") => "This file is too large to edit on the phone.".to_owned(),
        Some(_) => "Only text files can be edited on the phone.".to_owned(),
        None => error,
    })?;
    if content_hash(&current) != base_hash {
        // A retry of a save that already landed (the reply was lost): the file already holds
        // exactly this text, so answer as the first save did instead of a conflict.
        if current == text {
            return Ok(json!({"path": path, "hash": content_hash(text), "total": text.len()}));
        }
        return Err(WRITE_CONFLICT.into());
    }
    let base = root.canonicalize().map_err(|e| e.to_string())?;
    let file = root.join(path).canonicalize().map_err(|e| e.to_string())?;
    if !file.starts_with(&base) || into_git(root, path) {
        return Err("That file is not available.".into());
    }
    let name = file.file_name().and_then(|n| n.to_str()).ok_or("That file is not available.")?;
    let temp = file.with_file_name(format!(".{name}.pandacode-{}.tmp", uuid::Uuid::new_v4().simple()));
    let permissions = std::fs::metadata(&file).map_err(|e| e.to_string())?.permissions();
    let saved = std::fs::write(&temp, text).and_then(|()| std::fs::set_permissions(&temp, permissions)).and_then(|()| std::fs::rename(&temp, &file));
    if let Err(error) = saved {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("Couldn't save {path}: {error}"));
    }
    Ok(json!({"path": path, "hash": content_hash(text), "total": text.len()}))
}

/// The new text: at most [`WRITE_LIMIT`] bytes and no NUL (it must stay a text file). Empty is fine.
fn write_text_param(params: &Value) -> Result<String> {
    let text = params.get("text").and_then(Value::as_str).ok_or("Missing text.")?;
    if text.len() > WRITE_LIMIT {
        return Err("This file is too large to save from the phone (64 KB at most).".into());
    }
    if text.contains('\0') {
        return Err("Only text can be saved.".into());
    }
    Ok(text.to_owned())
}

fn hash_param(params: &Value) -> Result<String> {
    let hash = params.get("baseHash").and_then(Value::as_str).unwrap_or_default();
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("Reload the file before saving.".into());
    }
    Ok(hash.to_owned())
}

/// Whether `path` resolves (through symlinks) into a `.git` folder or file under `root`, which
/// `path_param`'s textual `.git` check cannot see. Unresolvable paths are left to the readers.
fn into_git(root: &Path, path: &str) -> bool {
    let (Ok(root), Ok(resolved)) = (root.canonicalize(), root.join(path).canonicalize()) else { return false };
    resolved.strip_prefix(&root).is_ok_and(|inside| inside.components().any(|part| part.as_os_str().to_str().is_some_and(|name| name.eq_ignore_ascii_case(".git"))))
}

/// Refuses a path that resolves into `.git` (as `path_param` refuses one that names it).
fn outside_git(root: &Path, path: &str) -> Result<()> {
    if into_git(root, path) {
        return Err("That file is not available.".into());
    }
    Ok(())
}

fn required_path(params: &Value) -> Result<String> {
    path_param(params, "path")?.ok_or_else(|| "Missing path.".into())
}

fn parse_list(p: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(List { target: target_param(p)?, path: path_param(p, "path")? }))
}
fn parse_read(p: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Read { target: target_param(p)?, path: required_path(p)?, offset: offset_param(p)? }))
}
fn parse_image(p: &Value) -> Result<Box<dyn Run>> {
    let path = required_path(p)?;
    if !is_image(&path) {
        return Err("Only PNG, JPEG, GIF, WebP and SVG images can be shown.".into());
    }
    Ok(Box::new(Image { target: target_param(p)?, path, offset: offset_param(p)? }))
}
fn parse_write(p: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Write { target: target_param(p)?, path: required_path(p)?, text: write_text_param(p)?, base_hash: hash_param(p)? }))
}
fn parse_search(p: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Search { target: target_param(p)?, query: query_param(p)? }))
}
fn parse_grep(p: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Grep {
        target: target_param(p)?,
        query: query_param(p)?,
        match_case: flag_param(p, "matchCase")?,
        whole_word: flag_param(p, "wholeWord")?,
        regex: flag_param(p, "regex")?,
    }))
}

pub(crate) const METHODS: &[Method] = &[
    Method { name: "projects.list", access: Access::View, read_only: true, parse: |_| Ok(Box::new(Projects)) },
    Method { name: "files.list", access: Access::View, read_only: true, parse: parse_list },
    Method { name: "files.read", access: Access::View, read_only: true, parse: parse_read },
    Method { name: "files.image", access: Access::View, read_only: true, parse: parse_image },
    Method { name: "files.search", access: Access::View, read_only: true, parse: parse_search },
    Method { name: "files.grep", access: Access::View, read_only: true, parse: parse_grep },
    Method { name: "files.write", access: Access::Full, read_only: false, parse: parse_write },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_checkouts_match_literally_or_canonically() {
        let dir = std::env::temp_dir().join(format!("pandacode-files-same-{}", uuid::Uuid::new_v4().simple()));
        let root = dir.join("repo");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir(&root).unwrap();
        let elsewhere = dir.join("other");
        std::fs::create_dir(&elsewhere).unwrap();
        assert!(any_same_checkout(&root, std::slice::from_ref(&root)));
        assert!(any_same_checkout(&root, &[elsewhere.clone(), root.join(".")]), "the same folder, spelled differently");
        assert!(!any_same_checkout(&root, &[elsewhere, dir.join("missing")]));
        assert!(!any_same_checkout(&root, &[]));
        std::fs::remove_dir_all(&dir).unwrap();
        let source = include_str!("files.rs");
        let body = &source[source.find("async fn refuse_running_in").unwrap()..];
        assert!(body.find("crate::blocking(").unwrap() < body.find("any_same_checkout(&root").unwrap(), "canonicalizing runs off the async runtime");
    }

    fn parse(name: &str, params: Value) -> Result<Box<dyn Run>> {
        (super::super::find(name).unwrap().parse)(&params)
    }

    #[test]
    fn every_files_method_is_read_only_view_but_write() {
        let write = super::super::find("files.write").unwrap();
        assert_eq!(write.access, Access::Full);
        assert!(!write.read_only);
        for method in METHODS.iter().filter(|m| m.name != "files.write") {
            assert_eq!(method.access, Access::View, "{}", method.name);
            assert!(method.read_only, "{}", method.name);
        }
    }

    /// Round 20: build-tool and sync-tool credentials, password databases, the legacy Docker
    /// login and the `hub` CLI's token.
    #[test]
    fn round_20_secret_files_are_recognised() {
        for path in ["home/.m2/settings.xml", ".M2/Settings.xml", "gradle.properties", "app/Gradle.Properties", ".yarnrc", "pip.conf", ".config/pip/pip.conf", ".config/rclone/rclone.conf", "vault/Passwords.KDBX", ".dockercfg", ".config/hub", "home/.Config/Hub"] {
            assert!(is_secret_path(Path::new(path)), "{path}");
        }
        for path in ["settings.xml", "maven/settings.xml", "gradle.properties.md/readme", "docs/pip.md", "hub", "config/hub", "rclone.md", "kdbx.txt"] {
            assert!(!is_secret_path(Path::new(path)), "{path}");
        }
    }

    #[test]
    fn round_21_secret_files_are_recognised() {
        for path in [
            ".gemini/oauth_creds.json",
            "home/.Gemini/OAuth_Creds.json",
            ".qwen/oauth_creds.json",
            ".config/gcloud/legacy_credentials/me@example.com/adc.json",
            "gcloud/Legacy_Credentials/a/b/adc.json",
            ".azure/msal_token_cache.json",
            ".config/github-copilot/apps.json",
            ".netlify/config.json",
            "home/.wrangler/config/default.toml",
            ".wrangler/config/default.toml",
        ] {
            assert!(is_secret_path(Path::new(path)), "{path}");
        }
        for path in [
            "oauth_creds.json",
            "gemini/oauth_creds.json",
            "src/adc.json",
            "gcloud/adc.json",
            "legacy_credentials/adc.json",
            "gcloud/legacy_credentials/readme.md",
            "apps.json",
            "copilot/apps.json",
            "netlify/config.json",
            "wrangler/config/default.toml",
            "config/default.toml",
            "x.wrangler/config/default.toml",
        ] {
            assert!(!is_secret_path(Path::new(path)), "{path}");
        }
    }

    #[test]
    fn round_22_secret_files_are_recognised() {
        for path in [
            ".local/share/fish/fish_history",
            ".psql_history",
            "home/.MySQL_History",
            ".node_repl_history",
            ".sqlite_history",
            ".irb_history",
            ".huggingface/token",
            ".cache/huggingface/token",
            "Library/Application Support/ngrok/ngrok.yml",
            ".config/github-copilot/hosts.json",
            ".config/configstore/firebase-tools.json",
            ".config/stripe/config.toml",
            "home/.Fly/Config.yml",
        ] {
            assert!(is_secret_path(Path::new(path)), "{path}");
        }
        for path in ["token", "src/token", "hosts.json", "copilot/hosts.json", "firebase-tools.json", "stripe/config.toml", "fly/config.yml", "config.yml", "history.md"] {
            assert!(!is_secret_path(Path::new(path)), "{path}");
        }
    }

    /// Round 22: `/`, the home folder and its ancestors expose the home folder; a folder inside
    /// it, a sibling and a folder elsewhere do not.
    #[test]
    fn a_home_rooted_project_is_full_only() {
        let dir = std::env::temp_dir().join(format!("pandacode-files-home-{}", uuid::Uuid::new_v4().simple()));
        let home = dir.join("users/me");
        std::fs::create_dir_all(home.join("code/app")).unwrap();
        std::fs::create_dir_all(dir.join("users/meet")).unwrap();
        let home_ref = Some(home.as_path());
        assert!(exposes_home(Path::new("/"), home_ref));
        assert!(exposes_home(Path::new("/"), None), "the file system root needs no home to be refused");
        assert!(exposes_home(&home, home_ref));
        assert!(exposes_home(&home.join("code/.."), home_ref), "spelled with `..`");
        assert!(exposes_home(&dir.join("users"), home_ref));
        assert!(exposes_home(&dir, home_ref));
        assert!(!exposes_home(&home.join("code/app"), home_ref));
        assert!(!exposes_home(&dir.join("users/meet"), home_ref), "a sibling whose name starts with home's");
        assert!(!exposes_home(&home.join("code/app"), None));
        #[cfg(unix)]
        {
            let link = dir.join("link-to-home");
            std::os::unix::fs::symlink(&home, &link).unwrap();
            assert!(exposes_home(&link, home_ref), "a symlink to home");
        }
        assert!(allow_root(Path::new("/"), true).is_ok(), "Full may browse it");
        assert_eq!(allow_root(Path::new("/"), false).unwrap_err(), HOME_ROOT_REFUSED);
        // Round 23: PandaCode's app data folder, a folder holding it, or one inside it.
        let data = home.join("Library/Application Support/PandaCode");
        std::fs::create_dir_all(data.join("attachments/s1")).unwrap();
        let data_ref = Some(data.as_path());
        assert!(touches_app_data(&data, data_ref));
        assert!(touches_app_data(&home.join("Library"), data_ref), "a folder that holds it");
        assert!(touches_app_data(&data.join("attachments/s1"), data_ref), "a folder inside it");
        assert!(touches_app_data(&data.join("attachments/../attachments"), data_ref), "spelled with `..`");
        assert!(!touches_app_data(&home.join("code/app"), data_ref));
        assert!(!touches_app_data(&home.join("Library/Application Support/PandaCodeX"), data_ref), "a sibling whose name starts with it");
        assert!(!touches_app_data(&data, None), "no data folder known");
        #[cfg(unix)]
        {
            let link = dir.join("link-to-data");
            std::os::unix::fs::symlink(&data, &link).unwrap();
            assert!(touches_app_data(&link, data_ref), "a symlink to it");
        }
        let source = include_str!("files.rs");
        let allow = &source[source.find("pub(crate) fn allow_root(").unwrap()..];
        assert!(allow[..allow.find("\n}\n").unwrap()].contains("touches_app_data(root, crate::secret_store::dir())"));
        std::fs::remove_dir_all(&dir).unwrap();
        // Every phone read path checks the root before reading.
        let source = include_str!("files.rs");
        for method in ["impl Run for List", "impl Run for Read", "impl Run for Search", "impl Run for Grep", "pub(crate) fn checked_image_data_url("] {
            let body = &source[source.find(method).unwrap()..];
            let body = &body[..body.find("\n}\n").unwrap()];
            assert!(body.contains("allow_root(&root, full)?") || body.contains("allow_root(root, device_has_full)?"), "{method}");
        }
        let host = include_str!("../host.rs");
        let diff = &host[host.find("Call::Diff { session_id, path, staged } =>").unwrap()..];
        assert!(diff[..diff.find("Call::BotsList").unwrap()].contains("allow_root(&root, full)?"), "task.diff");
        let git = include_str!("git.rs");
        let turn = &git[git.find("impl Run for TurnDiff").unwrap()..];
        assert!(turn[..turn.find("\n}\n").unwrap()].contains("allow_root(root, full)?"), "turn.diff");
    }

    #[test]
    fn secret_files_are_recognised_by_name() {
        for name in [".env", ".ENV", ".env.local", ".env.production", "server.pem", "tls.key", "id_rsa", "id_rsa.pub", "id_ed25519", ".npmrc", ".netrc", ".pypirc", "credentials.json", "credentials-prod.json", "cert.p12", "release.keystore", ".envrc", ".dev.vars", "credentials", ".git-credentials", ".pgpass", "prod.tfvars", ".htpasswd", "release.jks", "kubeconfig"] {
            assert!(is_secret_name(name), "{name}");
        }
        for path in [".aws/credentials", ".aws/config", "home/.AWS/config", "home/.kube/config", ".docker/config.json", "infra/prod.tfvars", ".envrc", "gcloud/application_default_credentials.json", "deploy/gcp-credentials.json", "keys/service-account.json", "service-account-prod.json"] {
            assert!(is_secret_path(Path::new(path)), "{path}");
        }
        for path in ["src/config", "app/config.json", ".kube/settings", "docker/config.json", "aws/config", "src/credentials.ts", "service.json"] {
            assert!(!is_secret_path(Path::new(path)), "{path}");
        }
        for name in ["env.ts", "README.md", "keys.ts", "key.rs", "credentials.ts", "my.pem.txt", "package.json"] {
            assert!(!is_secret_name(name), "{name}");
        }
        for name in ["id_ecdsa", "id_ecdsa.pub", "id_dsa", "ID_DSA", "cert.pfx", "terraform.tfstate", "terraform.tfstate.backup", ".yarnrc.yml"] {
            assert!(is_secret_name(name), "{name}");
        }
        for path in [".ssh/known_hosts", "home/.ssh/config", "x/.SSH/keys/deploy", ".config/gh/hosts.yml", "gh/hosts.yml"] {
            assert!(is_secret_path(Path::new(path)), "{path}");
        }
        for path in ["ssh/config", "docs/ssh.md", "gh/config.yml", "hosts.yml", "my.ssh/readme", "terraform.tf", ".yarnrc.example"] {
            assert!(!is_secret_path(Path::new(path)), "{path}");
        }
        // Round 8: GnuPG homes, Vault/S3/Boto tokens, tool auth files and VPN profiles.
        for path in [".gnupg/private-keys-v1.d/x.key", "home/.GnuPG/pubring.kbx", ".vault-token", "home/.s3cfg", ".boto", ".codex/auth.json", "vpn/office.ovpn", "VPN/Office.OVPN"] {
            assert!(is_secret_path(Path::new(path)), "{path}");
        }
        for path in ["gnupg/readme.md", "src/auth.json.ts", "docs/ovpn.md"] {
            assert!(!is_secret_path(Path::new(path)), "{path}");
        }
        // Round 11: MCP configs, Claude's local settings and secrets.* files.
        for path in [".mcp.json", "app/.MCP.json", ".claude/settings.local.json", "x/.Claude/Settings.Local.json", "secrets.json", "config/secrets.yaml", "secrets.toml", "Secrets.yml"] {
            assert!(is_secret_path(Path::new(path)), "{path}");
        }
        for path in ["mcp.json", ".claude/settings.json", "claude/settings.local.json", "src/secrets.rs.md/readme", "secret.json", "docs/secrets"] {
            assert!(!is_secret_path(Path::new(path)), "{path}");
        }
        // Round 12: stage env files and service-account keys.
        for path in ["prod.env", "config/Staging.ENV", "serviceAccountKey.json", "app/firebase-adminsdk-x1y2z.json", "my-app-service-account.json", "gcp-service-account-key.json"] {
            assert!(is_secret_path(Path::new(path)), "{path}");
        }
        for path in ["env.md", "src/env.ts", "prod.env.example.md/readme", "serviceAccount.md", "firebase.json", "service.json"] {
            assert!(!is_secret_path(Path::new(path)), "{path}");
        }
        // Round 16: PandaConnect's own files, dot-credentials, signing keys and tool logins.
        for path in ["connect-secrets.json", "app/Connect-Grants.json", ".claude/.credentials.json", ".credentials.json", "credentials.toml", ".cargo/credentials.toml", "AuthKey_ABC123.p8", "server.ppk", "backup.tar.gpg", ".terraformrc", ".pypirc"] {
            assert!(is_secret_path(Path::new(path)), "{path}");
        }
        for path in ["connect.json", "grants.json", "credentials.md", "src/p8.rs", "gpg.md", "terraformrc.md"] {
            assert!(!is_secret_path(Path::new(path)), "{path}");
        }
        // Round 17: MCP configs under other names, Claude's user config and shell histories.
        for path in [".cursor/mcp.json", "app/.Cursor/MCP.json", ".vscode/mcp.json", ".roo/mcp.json", ".gemini/settings.json", "home/.codex/config.toml", ".claude.json", "home/.Claude.json", ".zsh_history", ".bash_history", ".python_history"] {
            assert!(is_secret_path(Path::new(path)), "{path}");
        }
        for path in ["cursor/mcp.json", ".vscode/settings.json", ".gemini/config.json", ".codex/readme.md", "codex/config.toml", "claude.json", "zsh_history.md", "docs/history"] {
            assert!(!is_secret_path(Path::new(path)), "{path}");
        }
        assert!(glob_match("a*b*c", "axxbyyc") && !glob_match("a*b*c", "axxc") && glob_match("*", "") && !glob_match("ab", "abc"));
        assert_eq!(FULL_PROBE, "terminal.open");
        assert_eq!(super::super::find(FULL_PROBE).unwrap().access, Access::Full);
    }

    #[test]
    fn files_write_needs_full_access_for_remote_tasks() {
        // A Full-scope phone with the host switch off must not plant hooks that run as the user.
        let source = include_str!("files.rs");
        let body = &source[source.find("impl Run for Write").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let gate = body.find("require_full_access_to(ctx.full_access, super::terminal::EDIT_FILES)?").expect("files.write checks Full access");
        assert!(gate < body.find("write_text").unwrap(), "checked before writing");
        assert_eq!(super::super::terminal::require_full_access_to(false, super::super::terminal::EDIT_FILES).unwrap_err(), "Turn on Full access for remote tasks on this computer to edit files.");
    }

    #[test]
    fn secret_files_need_full_access_even_through_a_symlink() {
        let dir = std::env::temp_dir().join(format!("pandacode-files-secret-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join(".env"), "TOKEN=x").unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() {}").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join(".env"), dir.join("src/config.txt")).unwrap();
        assert_eq!(allow_secret(&dir, ".env", false).unwrap_err(), SECRET_REFUSED);
        assert!(allow_secret(&dir, ".env", true).is_ok());
        assert!(allow_secret(&dir, "src/main.rs", false).is_ok());
        #[cfg(unix)]
        assert!(allow_secret(&dir, "src/config.txt", false).is_err(), "a symlink to a secret is a secret");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Round 12: a hard link to a file outside the project (say `~/.ssh/id_rsa`) carries no
    /// secret name and no symlink, so remote reads and writes refuse any linked file.
    #[cfg(unix)]
    #[test]
    fn hard_linked_files_are_refused_for_reads_and_writes() {
        let dir = std::env::temp_dir().join(format!("pandacode-files-hardlink-{}", uuid::Uuid::new_v4().simple()));
        let outside = std::env::temp_dir().join(format!("pandacode-files-outside-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("id_rsa"), "PRIVATE KEY").unwrap();
        std::fs::hard_link(outside.join("id_rsa"), dir.join("notes.txt")).unwrap();
        std::fs::write(dir.join("plain.txt"), "hello").unwrap();
        std::os::unix::fs::symlink(dir.join("notes.txt"), dir.join("via-link.txt")).unwrap();
        // The readers compare canonical paths (macOS temp dirs sit behind /var -> /private/var).
        let dir = dir.canonicalize().unwrap();
        assert_eq!(refuse_hard_link(&dir, "notes.txt").unwrap_err(), HARD_LINK_REFUSED);
        assert_eq!(refuse_hard_link(&dir, "via-link.txt").unwrap_err(), HARD_LINK_REFUSED, "a symlink to a linked file too");
        assert!(refuse_hard_link(&dir, "plain.txt").is_ok());
        assert!(refuse_hard_link(&dir, "missing.txt").is_ok(), "left to the reader's error");
        assert!(refuse_hard_link(&dir, ".").is_ok(), "folders have many links; only files are refused");
        let hash = content_hash("PRIVATE KEY");
        assert_eq!(write_text(&dir, "notes.txt", "changed", &hash).unwrap_err(), HARD_LINK_REFUSED);
        assert_eq!(std::fs::read_to_string(outside.join("id_rsa")).unwrap(), "PRIVATE KEY", "nothing written");
        write_text(&dir, "plain.txt", "changed", &content_hash("hello")).unwrap();
        let source = include_str!("files.rs");
        for method in ["impl Run for Read", "fn checked_image_data_url"] {
            let body = &source[source.find(method).unwrap()..];
            let body = &body[..body.find("\n}\n").unwrap()];
            let gate = body.find("refuse_hard_link(").unwrap_or_else(|| panic!("{method} checks links"));
            assert!(gate < body.find("read_page(").or_else(|| body.find("image_data_url_checked(")).unwrap(), "{method}: before reading");
        }
        // files.grep: a hard link named notes.txt pointing outside the project is never returned.
        let found = crate::workspace::search_text_for_phone(&dir, "PRIVATE", true, false, false).unwrap();
        assert!(found.files.iter().all(|file| file.path != "notes.txt" && file.path != "via-link.txt"), "{:?}", found.files.iter().map(|f| &f.path).collect::<Vec<_>>());
        let grep = &source[source.find("impl Run for Grep").unwrap()..];
        assert!(grep[..grep.find("\n}\n").unwrap()].contains("search_text_for_phone("), "files.grep searches as a phone");
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn targets_need_a_project_or_task_and_prefer_the_task() {
        assert_eq!(target_param(&json!({"projectId": "p1"})).unwrap(), Target::Project("p1".into()));
        assert_eq!(target_param(&json!({"projectId": "p1", "sessionId": "s1"})).unwrap(), Target::Task("s1".into()));
        assert!(target_param(&json!({})).is_err());
        assert!(target_param(&json!({"projectId": "has space"})).is_err());
        assert!(target_param(&json!({"sessionId": 4})).is_err());
    }

    #[test]
    fn paths_never_leave_the_root_or_enter_git() {
        for path in ["../etc/passwd", "/etc/passwd", "src/../../x", ".git/config", "a/.git/HEAD", ""] {
            assert!(parse("files.read", json!({"projectId": "p", "path": path})).is_err(), "{path}");
            assert!(parse("files.list", json!({"projectId": "p", "path": path})).is_err(), "{path}");
        }
        assert!(parse("files.read", json!({"projectId": "p"})).is_err(), "read needs a path");
        assert!(parse("files.list", json!({"projectId": "p"})).is_ok(), "list defaults to the root");
        assert!(parse("files.read", json!({"projectId": "p", "path": "src/main.rs", "offset": 10})).is_ok());
        assert!(parse("files.read", json!({"projectId": "p", "path": "a", "offset": -1})).is_err());
        assert!(parse("files.image", json!({"projectId": "p", "path": "notes.txt"})).is_err());
        assert!(parse("files.image", json!({"projectId": "p", "path": "logo.PNG"})).is_ok());
    }

    #[test]
    fn queries_are_bounded() {
        assert!(parse("files.search", json!({"projectId": "p", "query": ""})).is_err());
        assert!(parse("files.search", json!({"projectId": "p", "query": "x".repeat(513)})).is_err());
        assert!(parse("files.grep", json!({"projectId": "p", "query": "a\0b"})).is_err());
        assert!(parse("files.grep", json!({"projectId": "p", "query": "todo", "regex": "yes"})).is_err());
        assert!(parse("files.grep", json!({"projectId": "p", "query": "todo", "matchCase": true})).is_ok());
    }

    #[test]
    fn text_pages_cover_the_file_on_line_and_char_boundaries() {
        let text = "é line\n".repeat(40_000);
        let mut offset = 0;
        let mut joined = String::new();
        loop {
            let page = text_page(&text, offset, READ_CHUNK).unwrap();
            assert!(page.to_string().len() <= PAGE_BUDGET);
            let chunk = page["text"].as_str().unwrap();
            assert!(chunk.ends_with('\n'));
            joined.push_str(chunk);
            offset += chunk.len();
            if page["done"] == true {
                break;
            }
        }
        assert_eq!(joined, text);
        assert!(text_page(&text, 1, READ_CHUNK).is_err(), "inside é");
        assert!(text_page(&text, text.len() + 1, READ_CHUNK).is_err());
    }

    #[test]
    fn escaped_text_still_fits_the_budget() {
        let text = "\u{1}".repeat(READ_CHUNK * 2);
        let page = text_page(&text, 0, READ_CHUNK).unwrap();
        assert!(page.to_string().len() <= PAGE_BUDGET);
        assert_eq!(page["done"], false);
    }

    #[test]
    fn data_pages_split_on_base64_quads() {
        let data = "QUJD".repeat(DATA_CHUNK / 2);
        let first = data_page("image/png", &data, 0).unwrap();
        assert_eq!(first["data"].as_str().unwrap().len(), DATA_CHUNK);
        assert_eq!(first["done"], false);
        let last = data_page("image/png", &data, DATA_CHUNK).unwrap();
        assert_eq!(last["done"], true);
        assert!(data_page("image/png", &data, 3).is_err());
        assert_eq!(split_data_url("data:image/png;base64,QUJD").unwrap(), ("image/png", "QUJD"));
        assert!(split_data_url("https://x").is_err());
    }

    #[test]
    fn reads_and_lists_through_the_desktop_guards() {
        let dir = std::env::temp_dir().join(format!("pandacode-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/a.txt"), "hello\n").unwrap();
        std::fs::write(dir.join("bin.dat"), [0u8, 1, 2]).unwrap();
        std::fs::write(dir.join("big.txt"), "x".repeat(200 * 1024)).unwrap();
        let root = dir.canonicalize().unwrap();
        let entries = crate::workspace::list_files(&root, None).unwrap();
        assert_eq!(entries[0].name, "src", "folders first");
        let error = crate::workspace::read_file(&root, "bin.dat".into()).unwrap_err();
        assert_eq!(unreadable("bin.dat", &error).unwrap()["kind"], "binary");
        let error = crate::workspace::read_file(&root, "big.txt".into()).unwrap_err();
        assert_eq!(unreadable("big.txt", &error).unwrap()["kind"], "tooLarge");
        assert!(unreadable("x", "No such file").is_none());
        #[cfg(unix)]
        {
            let outside = std::env::temp_dir().join(format!("pandacode-outside-{}", uuid::Uuid::new_v4()));
            std::fs::write(&outside, "secret").unwrap();
            std::os::unix::fs::symlink(&outside, root.join("escape.txt")).unwrap();
            assert!(crate::workspace::read_file(&root, "escape.txt".into()).is_err(), "a link out of the root is refused");
            assert!(!crate::workspace::list_files(&root, None).unwrap().iter().any(|e| e.name == "escape.txt"));
            let _ = std::fs::remove_file(outside);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_into_git_are_refused() {
        let dir = std::env::temp_dir().join(format!("pandacode-files-git-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join(".git/config"), "[remote] url=secret").unwrap();
        std::fs::write(dir.join("src/a.txt"), "ok").unwrap();
        let root = dir.canonicalize().unwrap();
        std::os::unix::fs::symlink(root.join(".git/config"), root.join("config.txt")).unwrap();
        std::os::unix::fs::symlink(root.join(".git"), root.join("g")).unwrap();
        std::os::unix::fs::symlink(root.join("src/a.txt"), root.join("alias.txt")).unwrap();
        assert!(into_git(&root, "config.txt"));
        assert!(into_git(&root, "g"));
        assert!(into_git(&root, "g/config"));
        assert!(outside_git(&root, "g/config").is_err());
        assert!(!into_git(&root, "alias.txt"));
        assert!(!into_git(&root, "src/a.txt"));
        assert!(!into_git(&root, "missing.txt"), "unresolvable paths are left to the readers");
        assert!(outside_git(&root, "src/a.txt").is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn grep_results_are_bounded() {
        let files: Vec<Value> = (0..5).map(|i| json!({"path": format!("f{i}"), "matches": (0..10).map(|line| json!({"line": line, "text": "x", "ranges": [[0, 1]]})).collect::<Vec<_>>()})).collect();
        let bounded = bound_grep(json!({"files": files, "truncated": false}), 3, 25);
        let files = bounded["files"].as_array().unwrap();
        assert_eq!(files.len(), 3);
        assert_eq!(files[2]["matches"].as_array().unwrap().len(), 5);
        assert_eq!(bounded["truncated"], true);
    }

    #[test]
    fn write_params_are_checked() {
        let hash = content_hash("x");
        let ok = json!({"projectId": "p", "path": "src/a.txt", "text": "", "baseHash": hash});
        assert!(parse("files.write", ok.clone()).is_ok(), "empty text is fine");
        let with = |key: &str, value: Value| {
            let mut p = ok.clone();
            p[key] = value;
            parse("files.write", p)
        };
        for path in ["../x", ".git/config", "/etc/hosts", ""] {
            assert!(with("path", json!(path)).is_err(), "{path}");
        }
        assert!(with("text", json!("a\0b")).is_err());
        assert!(with("text", json!("x".repeat(WRITE_LIMIT + 1))).is_err());
        assert!(with("text", json!(4)).is_err());
        assert!(with("baseHash", json!("abc")).is_err());
        assert!(with("baseHash", json!(hash.to_uppercase())).is_err());
        assert!(with("baseHash", Value::Null).is_err());
        assert!(parse("files.write", json!({"path": "a", "text": "", "baseHash": hash})).is_err(), "needs a target");
        assert_eq!(content_hash("hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    }

    #[test]
    fn writes_need_the_current_hash_and_a_text_file() {
        let dir = std::env::temp_dir().join(format!("pandacode-files-write-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join("src/a.txt"), "one\n").unwrap();
        std::fs::write(dir.join("bin.dat"), [0u8, 1, 2]).unwrap();
        std::fs::write(dir.join("big.txt"), "x".repeat(200 * 1024)).unwrap();
        std::fs::write(dir.join(".git/config"), "[core]").unwrap();
        let root = dir.canonicalize().unwrap();
        let page = read_page(&root, "src/a.txt".into(), 0, false).unwrap();
        let base = page["hash"].as_str().unwrap().to_owned();
        assert_eq!(base, content_hash("one\n"));
        let saved = write_text(&root, "src/a.txt", "two\n", &base).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("src/a.txt")).unwrap(), "two\n");
        assert_eq!(saved["hash"], content_hash("two\n"));
        assert_eq!(write_text(&root, "src/a.txt", "three\n", &base).unwrap_err(), WRITE_CONFLICT, "a stale base is a conflict");
        // Round 7: the same save retried after its reply was lost succeeds instead of conflicting.
        let retried = write_text(&root, "src/a.txt", "two\n", &base).unwrap();
        assert_eq!(retried, saved, "a retry answers as the save that landed");
        assert_eq!(std::fs::read_to_string(root.join("src/a.txt")).unwrap(), "two\n");
        assert!(write_text(&root, "bin.dat", "x", &content_hash("")).unwrap_err().contains("text"));
        assert!(write_text(&root, "big.txt", "x", &content_hash("")).unwrap_err().contains("large"));
        assert!(write_text(&root, "missing.txt", "x", &content_hash("")).is_err(), "only existing files");
        assert!(!std::fs::read_dir(root.join("src")).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join(".git/config"), root.join("config.txt")).unwrap();
            assert!(write_text(&root, "config.txt", "x", &content_hash("[core]")).is_err(), "a link into .git");
            let outside = std::env::temp_dir().join(format!("pandacode-write-outside-{}", uuid::Uuid::new_v4().simple()));
            std::fs::write(&outside, "keep").unwrap();
            std::os::unix::fs::symlink(&outside, root.join("escape.txt")).unwrap();
            assert!(write_text(&root, "escape.txt", "x", &content_hash("keep")).is_err(), "a link out of the root");
            assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep");
            std::fs::write(root.join(".env"), "TOKEN=x").unwrap();
            assert_eq!(allow_secret(&root, ".env", false).unwrap_err(), SECRET_REFUSED);
            let _ = std::fs::remove_file(outside);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn home_is_shortened() {
        if let Ok(home) = std::env::var("HOME") {
            assert_eq!(display_path(&format!("{home}/code/app")), "~/code/app");
            assert_eq!(display_path(&home), "~");
            assert_eq!(display_path(&format!("{home}x/app")), "app", "a sibling of home is outside it");
        }
        // Round 20: outside the home folder only the folder's name goes to the phone.
        assert_eq!(display_path("/Volumes/Work Disk/clients/acme"), "acme");
        assert_eq!(display_path("/opt/src/app/"), "app");
        assert_eq!(display_path("/"), "");
    }

    /// Round 15: `task.workspaceImage` (host.rs) and `files.image` both read through
    /// `checked_image_data_url`, so a symlinked secret, a symlink into `.git` and a hard link
    /// are refused before any bytes are read.
    #[cfg(unix)]
    #[test]
    fn workspace_images_refuse_secrets_git_and_hard_links() {
        let dir = std::env::temp_dir().join(format!("pandacode-files-image-{}", uuid::Uuid::new_v4().simple()));
        let outside = std::env::temp_dir().join(format!("pandacode-files-image-out-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(dir.join(".env"), "TOKEN=secret").unwrap();
        std::fs::write(dir.join(".git/config"), "[remote]").unwrap();
        std::fs::write(dir.join("plain.png"), "png-bytes").unwrap();
        std::fs::write(outside.join("id_rsa"), "PRIVATE KEY").unwrap();
        std::os::unix::fs::symlink(".env", dir.join("logo.png")).unwrap();
        std::os::unix::fs::symlink(".git/config", dir.join("git.png")).unwrap();
        std::fs::hard_link(outside.join("id_rsa"), dir.join("key.png")).unwrap();
        let dir = dir.canonicalize().unwrap();
        assert_eq!(checked_image_data_url(&dir, "logo.png", false).unwrap_err(), SECRET_REFUSED);
        assert_eq!(checked_image_data_url(&dir, "git.png", true).unwrap_err(), "That file is not available.");
        assert_eq!(checked_image_data_url(&dir, "key.png", true).unwrap_err(), HARD_LINK_REFUSED);
        assert!(checked_image_data_url(&dir, "plain.png", false).unwrap().starts_with("data:image/png;base64,"));
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(outside);
    }

    /// Round 15: every remote `image_data_url` read goes through the gated helper.
    #[test]
    fn remote_image_reads_go_through_the_checked_helper() {
        fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    sources(&path, out);
                } else if path.extension().is_some_and(|ext| ext == "rs") {
                    out.push(path);
                }
            }
        }
        let mut files = Vec::new();
        sources(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src/remote"), &mut files);
        assert!(files.len() > 5, "found the remote sources");
        let helper = "pub(crate) fn checked_image_data_url(";
        let needle = ["image", "_data_url("].concat();
        for file in files {
            let source = std::fs::read_to_string(&file).unwrap();
            let source = source.split("#[cfg(test)]\nmod tests").next().unwrap();
            for (at, _) in source.match_indices(&needle) {
                let allowed = source[..at].ends_with("checked_") || source[..at].rfind(helper).is_some_and(|start| !source[start..at].contains("\n}\n"));
                assert!(allowed, "{}: image_data_url must go through checked_image_data_url", file.display());
            }
        }
        let host = include_str!("../host.rs");
        let arm = &host[host.find("Call::WorkspaceImage { session_id, path, variant, offset } =>").unwrap()..];
        assert!(arm[..arm.find("\n        }\n").unwrap()].contains("checked_image_data_url(&root, &path, full)"), "task.workspaceImage uses the helper");
    }
    /// Round 16: `files.read`, `files.image` (and `task.workspaceImage`) open the resolved target
    /// once and check the handle, so the reply comes from the file the checks saw.
    #[cfg(unix)]
    #[test]
    fn reads_come_from_one_checked_handle() {
        let dir = std::env::temp_dir().join(format!("pandacode-files-handle-{}", uuid::Uuid::new_v4().simple()));
        let outside = std::env::temp_dir().join(format!("pandacode-files-handle-out-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(dir.join("src/a.txt"), "hello\n").unwrap();
        std::fs::write(dir.join("logo.png"), "png-bytes").unwrap();
        std::fs::write(dir.join("bin.dat"), [0u8, 1, 2]).unwrap();
        std::fs::write(dir.join("latin1.txt"), [0xffu8, 0xfe]).unwrap();
        std::fs::write(dir.join("big.txt"), "x".repeat(200 * 1024)).unwrap();
        std::fs::write(dir.join(".env"), "TOKEN=1").unwrap();
        std::fs::write(dir.join(".git/config"), "[core]").unwrap();
        std::fs::write(outside.join("id_rsa"), "PRIVATE KEY").unwrap();
        std::fs::write(outside.join("pic.png"), "outside").unwrap();
        std::fs::hard_link(outside.join("id_rsa"), dir.join("linked.txt")).unwrap();
        std::os::unix::fs::symlink(outside.join("id_rsa"), dir.join("escape.txt")).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("out")).unwrap();
        std::os::unix::fs::symlink("src/a.txt", dir.join("inside.txt")).unwrap();
        std::os::unix::fs::symlink(".env", dir.join("env.txt")).unwrap();
        std::os::unix::fs::symlink(".git/config", dir.join("git.txt")).unwrap();
        let root = dir.canonicalize().unwrap();
        assert_eq!(read_text_checked(&root, "src/a.txt", false).unwrap(), "hello\n");
        assert_eq!(read_text_checked(&root, "inside.txt", false).unwrap(), "hello\n", "an in-project link still reads");
        assert_eq!(read_text_checked(&root, "escape.txt", true).unwrap_err(), "Symlink points outside the project");
        assert_eq!(read_text_checked(&root, "out/id_rsa", true).unwrap_err(), "Symlink points outside the project", "a linked folder");
        assert_eq!(read_text_checked(&root, "linked.txt", true).unwrap_err(), HARD_LINK_REFUSED);
        assert_eq!(read_text_checked(&root, "env.txt", false).unwrap_err(), SECRET_REFUSED, "rechecked on the resolved target");
        assert_eq!(read_text_checked(&root, "env.txt", true).unwrap(), "TOKEN=1");
        assert_eq!(read_text_checked(&root, "git.txt", true).unwrap_err(), "That file is not available.");
        assert_eq!(read_text_checked(&root, "src", true).unwrap_err(), TEXT_NOT_REGULAR);
        assert_eq!(read_text_checked(&root, "big.txt", true).unwrap_err(), TEXT_TOO_LARGE);
        assert_eq!(unreadable("bin.dat", &read_text_checked(&root, "bin.dat", true).unwrap_err()).unwrap()["kind"], "binary");
        assert_eq!(unreadable("latin1.txt", &read_text_checked(&root, "latin1.txt", true).unwrap_err()).unwrap()["kind"], "binary");
        assert!(read_text_checked(&root, "missing.txt", true).is_err());
        let page = read_page(&root, "src/a.txt".into(), 0, false).unwrap();
        assert_eq!((page["text"].as_str(), page["hash"].as_str()), (Some("hello\n"), Some(content_hash("hello\n").as_str())));
        assert_eq!(read_page(&root, "big.txt".into(), 0, true).unwrap()["kind"], "tooLarge", "reply shapes unchanged");
        let url = image_data_url_checked(&root, "logo.png", false).unwrap();
        assert_eq!(url, format!("data:image/png;base64,{}", base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"png-bytes")));
        assert_eq!(image_data_url_checked(&root, "out/pic.png", true).unwrap_err(), "Symlink points outside the project");
        assert_eq!(image_data_url_checked(&root, "src/a.txt", true).unwrap_err(), "Only PNG, JPEG, GIF, WebP and SVG images can be shown");
        // The handle check itself: a FIFO is refused before it is opened, and a file whose inode
        // differs from the one checked (a swap between check and open) is refused.
        let fifo = root.join("pipe.png");
        assert!(std::process::Command::new("mkfifo").arg(&fifo).status().unwrap().success());
        assert_eq!(image_data_url_checked(&root, "pipe.png", true).unwrap_err(), IMAGE_UNAVAILABLE);
        let a = std::fs::metadata(root.join("src/a.txt")).unwrap();
        let b = std::fs::metadata(root.join("logo.png")).unwrap();
        assert!(same_file(&a, &a) && !same_file(&a, &b));
        assert!(open_no_follow(&root.join("escape.txt")).is_err(), "the final component is never followed");
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(outside);
    }
}
