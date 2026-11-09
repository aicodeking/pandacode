use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, OpenOptions},
    io,
    path::{Component, Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const MAX_UPLOAD_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SESSION_UPLOAD_BYTES: u64 = 128 * 1024 * 1024;
const MAX_SESSION_UPLOADS: usize = 16;
const MAX_LIST_ENTRIES: usize = 200;
const GRANT_TTL: Duration = Duration::from_secs(15 * 60);
const RETIRED_UPLOAD_TTL: Duration = Duration::from_secs(60 * 60);
const MAX_INLINE_IMAGE_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
struct Root {
    id: String,
    label: String,
    path: PathBuf,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    File,
    Folder,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Purpose {
    Project,
    Attachment,
    Theme,
    Executable,
    Folder,
}

#[derive(Clone)]
struct Grant {
    session: String,
    path: PathBuf,
    kind: Kind,
    purpose: Purpose,
    expires: Instant,
    upload: Option<Upload>,
}

#[derive(Clone)]
pub struct Upload {
    pub path: PathBuf,
    session: String,
    bytes: u64,
}

#[derive(Default)]
struct UploadUsage {
    bytes: u64,
    count: usize,
}

#[derive(Clone, Serialize)]
pub struct RootInfo {
    id: String,
    label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    path: String,
    directory: bool,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    root: String,
    path: String,
    entries: Vec<Entry>,
    has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
}

#[derive(Clone)]
pub struct ListRequest {
    root: Root,
    relative: String,
    after: Option<EntryKey>,
}

pub struct SelectionRequest {
    root: Root,
    relative: String,
    kind: Kind,
    purpose: Purpose,
}

pub struct LocateRequest {
    roots: Vec<Root>,
    path: PathBuf,
}

pub struct SelectedPath {
    path: PathBuf,
    kind: Kind,
    purpose: Purpose,
}

#[derive(Serialize)]
pub struct LocatedPath {
    root: String,
    path: String,
    name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
struct EntryKey {
    rank: u8,
    folded: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantInfo {
    grant: String,
    name: String,
    directory: bool,
    expires_at: u64,
}

pub struct Materialized {
    pub path: PathBuf,
    pub upload: Option<Upload>,
}

pub struct FileAccess {
    roots: HashMap<String, Root>,
    grants: HashMap<String, Grant>,
    uploads: HashMap<String, UploadUsage>,
    retired: Vec<(Instant, Upload)>,
    cache: PathBuf,
}

impl FileAccess {
    pub fn new(
        configured: &[String],
        projects: impl IntoIterator<Item = (String, PathBuf)>,
        cache: PathBuf,
    ) -> Result<Self, String> {
        let mut access = Self {
            roots: HashMap::new(),
            grants: HashMap::new(),
            uploads: HashMap::new(),
            retired: Vec::new(),
            cache,
        };
        for (label, path) in projects {
            if path.is_dir() {
                access.add_root(label, path)?;
            }
        }
        for configured in configured {
            let (label, path) = configured
                .split_once('=')
                .map(|(label, path)| (label.trim().to_owned(), PathBuf::from(path)))
                .unwrap_or_else(|| {
                    let path = PathBuf::from(configured);
                    let label = path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "Web root".to_owned());
                    (label, path)
                });
            if label.is_empty() {
                return Err("Web root labels cannot be empty.".into());
            }
            access.add_root(label, path)?;
        }
        Ok(access)
    }

    #[cfg(test)]
    pub fn empty() -> Self {
        Self {
            roots: HashMap::new(),
            grants: HashMap::new(),
            uploads: HashMap::new(),
            retired: Vec::new(),
            cache: std::env::temp_dir().join("pandacode-web-gateway-tests"),
        }
    }

    fn add_root(&mut self, label: String, path: PathBuf) -> Result<(), String> {
        let path = path
            .canonicalize()
            .map_err(|_| format!("Web root {label:?} is unavailable."))?;
        if !path.is_dir() || path.parent().is_none() {
            return Err(format!("Web root {label:?} must be a directory below /."));
        }
        if self.roots.values().any(|root| root.path == path) {
            return Ok(());
        }
        let id = super::auth::random_token().map_err(str::to_owned)?;
        self.roots.insert(id.clone(), Root { id, label, path });
        Ok(())
    }

    pub fn roots(&self) -> Vec<RootInfo> {
        let mut roots = self
            .roots
            .values()
            .map(|root| RootInfo {
                id: root.id.clone(),
                label: root.label.clone(),
            })
            .collect::<Vec<_>>();
        roots.sort_by_key(|root| root.label.to_lowercase());
        roots
    }

    pub fn prepare_list(
        &self,
        root_id: &str,
        relative: &str,
        cursor: Option<&str>,
    ) -> Result<ListRequest, &'static str> {
        let root = self.roots.get(root_id).ok_or("unknown file root")?.clone();
        if !relative.is_empty() {
            validate_relative(relative)?;
        }
        Ok(ListRequest {
            root,
            relative: relative.to_owned(),
            after: cursor.map(decode_cursor).transpose()?,
        })
    }

    pub fn prepare_select(
        &self,
        root_id: &str,
        relative: &str,
        kind: Kind,
        purpose: Purpose,
    ) -> Result<SelectionRequest, &'static str> {
        let root = self.roots.get(root_id).ok_or("unknown file root")?.clone();
        if !relative.is_empty() {
            validate_relative(relative)?;
        }
        Ok(SelectionRequest {
            root,
            relative: relative.to_owned(),
            kind,
            purpose,
        })
    }

    pub fn prepare_locate(&self, path: &str) -> Result<LocateRequest, &'static str> {
        if path.is_empty()
            || path.len() > 4096
            || path.chars().any(char::is_control)
            || !Path::new(path).is_absolute()
        {
            return Err("invalid host path");
        }
        Ok(LocateRequest {
            roots: self.roots.values().cloned().collect(),
            path: PathBuf::from(path),
        })
    }

    pub fn issue_selected(
        &mut self,
        session: &str,
        selected: SelectedPath,
    ) -> Result<GrantInfo, &'static str> {
        self.purge_expired();
        self.issue(
            session,
            selected.path,
            selected.kind,
            selected.purpose,
            None,
        )
    }

    #[cfg(test)]
    fn list(
        &self,
        root_id: &str,
        relative: &str,
        cursor: Option<&str>,
    ) -> Result<Listing, &'static str> {
        self.prepare_list(root_id, relative, cursor)?.run()
    }

    #[cfg(test)]
    fn select(
        &mut self,
        session: &str,
        root_id: &str,
        relative: &str,
        kind: Kind,
        purpose: Purpose,
    ) -> Result<GrantInfo, &'static str> {
        let selected = self
            .prepare_select(root_id, relative, kind, purpose)?
            .run()?;
        self.issue_selected(session, selected)
    }

    pub fn reserve_upload(&mut self, session: &str, bytes: u64) -> Result<(), &'static str> {
        self.purge_expired();
        if bytes == 0 || bytes > MAX_UPLOAD_BYTES {
            return Err("upload exceeds limit");
        }
        let usage = self.uploads.entry(session.to_owned()).or_default();
        if usage.count >= MAX_SESSION_UPLOADS
            || usage.bytes.saturating_add(bytes) > MAX_SESSION_UPLOAD_BYTES
        {
            return Err("session upload quota exceeded");
        }
        usage.count += 1;
        usage.bytes += bytes;
        Ok(())
    }

    pub fn cancel_upload(&mut self, session: &str, bytes: u64) {
        if let Some(usage) = self.uploads.get_mut(session) {
            usage.count = usage.count.saturating_sub(1);
            usage.bytes = usage.bytes.saturating_sub(bytes);
            if usage.count == 0 {
                self.uploads.remove(session);
            }
        }
    }

    pub fn upload_cache(&self) -> PathBuf {
        self.cache.clone()
    }

    pub fn create_upload(cache: &Path, name: &str) -> Result<(PathBuf, fs::File), &'static str> {
        validate_filename(name)?;
        fs::create_dir_all(cache).map_err(|_| "upload cache unavailable")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(cache, fs::Permissions::from_mode(0o700))
                .map_err(|_| "upload cache unavailable")?;
        }
        for _ in 0..8 {
            let token = super::auth::random_token().map_err(|_| "upload unavailable")?;
            let extension = Path::new(name)
                .extension()
                .map(|extension| format!(".{}", extension.to_string_lossy()))
                .unwrap_or_default();
            let path = cache.join(format!("{token}{extension}"));
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(&path) {
                Ok(file) => return Ok((path, file)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err("upload cache unavailable"),
            }
        }
        Err("upload unavailable")
    }

    pub fn finish_upload(
        &mut self,
        session: &str,
        path: PathBuf,
        name: &str,
        bytes: u64,
        purpose: Purpose,
    ) -> Result<GrantInfo, &'static str> {
        self.issue(
            session,
            path.clone(),
            Kind::File,
            purpose,
            Some(Upload {
                path,
                session: session.to_owned(),
                bytes,
            }),
        )
        .map(|mut grant| {
            grant.name = name.to_owned();
            grant
        })
    }

    fn issue(
        &mut self,
        session: &str,
        path: PathBuf,
        kind: Kind,
        purpose: Purpose,
        upload: Option<Upload>,
    ) -> Result<GrantInfo, &'static str> {
        let grant = format!(
            "webgrant_{}",
            super::auth::random_token().map_err(|_| "grant unavailable")?
        );
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Selected folder".into());
        self.grants.insert(
            grant.clone(),
            Grant {
                session: session.to_owned(),
                path,
                kind,
                purpose,
                expires: Instant::now() + GRANT_TTL,
                upload,
            },
        );
        Ok(GrantInfo {
            grant,
            name,
            directory: kind == Kind::Folder,
            expires_at: unix_seconds().saturating_add(GRANT_TTL.as_secs()),
        })
    }

    pub fn materialize(
        &mut self,
        session: &str,
        command: &str,
        token: &str,
    ) -> Result<Materialized, &'static str> {
        self.purge_expired();
        let grant = self.grants.get(token).ok_or("file grant required")?;
        if grant.session != session || !allows(grant.purpose, grant.kind, command) {
            return Err("file grant does not authorize this command");
        }
        validate_unchanged(grant)?;
        let grant = self.grants.remove(token).ok_or("file grant required")?;
        Ok(Materialized {
            path: grant.path,
            upload: grant.upload,
        })
    }

    pub fn materialize_many(
        &mut self,
        session: &str,
        command: &str,
        tokens: &[&str],
    ) -> Result<Vec<Materialized>, &'static str> {
        self.purge_expired();
        if tokens.is_empty() || tokens.len() > 16 {
            return Err("between one and 16 file grants required");
        }
        let mut unique = std::collections::HashSet::new();
        for token in tokens {
            if !unique.insert(*token) {
                return Err("file grants must be unique");
            }
            let grant = self.grants.get(*token).ok_or("file grant required")?;
            if grant.session != session || !allows(grant.purpose, grant.kind, command) {
                return Err("file grant does not authorize this command");
            }
            validate_unchanged(grant)?;
        }
        Ok(tokens
            .iter()
            .filter_map(|token| self.grants.remove(*token))
            .map(|grant| Materialized {
                path: grant.path,
                upload: grant.upload,
            })
            .collect())
    }

    pub fn release_upload(&mut self, upload: Upload) {
        let _ = fs::remove_file(&upload.path);
        self.cancel_upload(&upload.session, upload.bytes);
    }

    /// A timed-out native command may still have the file open. Retain it for a bounded grace
    /// period instead of deleting under that in-flight reader.
    pub fn retire_upload(&mut self, upload: Upload) {
        self.retired
            .push((Instant::now() + RETIRED_UPLOAD_TTL, upload));
    }

    pub fn release_session(&mut self, session: &str) {
        let tokens = self
            .grants
            .iter()
            .filter_map(|(token, grant)| (grant.session == session).then_some(token.clone()))
            .collect::<Vec<_>>();
        for token in tokens {
            if let Some(grant) = self.grants.remove(&token) {
                if let Some(upload) = grant.upload {
                    self.release_upload(upload);
                }
            }
        }
    }

    fn purge_expired(&mut self) {
        let now = Instant::now();
        let tokens = self
            .grants
            .iter()
            .filter_map(|(token, grant)| (grant.expires <= now).then_some(token.clone()))
            .collect::<Vec<_>>();
        for token in tokens {
            if let Some(grant) = self.grants.remove(&token) {
                if let Some(upload) = grant.upload {
                    self.release_upload(upload);
                }
            }
        }
        let mut retained = Vec::new();
        for (expires, upload) in std::mem::take(&mut self.retired) {
            if expires <= now {
                self.release_upload(upload);
            } else {
                retained.push((expires, upload));
            }
        }
        self.retired = retained;
    }
}

impl ListRequest {
    /// Directory traversal and canonicalization can block on slow or remote filesystems. Call this
    /// from a bounded blocking task, after cloning the immutable root out of `FileAccess`.
    pub fn run(self) -> Result<Listing, &'static str> {
        let directory = resolve(&self.root, &self.relative)?;
        if !directory.is_dir() {
            return Err("folder required");
        }
        // Keep only the next page while scanning. This preserves directory-first stable ordering
        // without allocating one entry per file in a very large host directory.
        let mut candidates = BTreeMap::<EntryKey, Entry>::new();
        let mut overflow = false;
        for item in fs::read_dir(directory).map_err(|_| "folder unavailable")? {
            let item = item.map_err(|_| "folder unavailable")?;
            let Ok(name) = item.file_name().into_string() else {
                continue;
            };
            let path = item.path();
            let metadata = fs::symlink_metadata(&path).map_err(|_| "file unavailable")?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            let canonical = path.canonicalize().map_err(|_| "file unavailable")?;
            if !canonical.starts_with(&self.root.path) {
                continue;
            }
            let directory = metadata.is_dir();
            let key = EntryKey::new(directory, &name);
            if self.after.as_ref().is_some_and(|after| &key <= after) {
                continue;
            }
            let child = if self.relative.is_empty() {
                name.clone()
            } else {
                format!("{}/{name}", self.relative)
            };
            candidates.insert(
                key,
                Entry {
                    name,
                    path: child,
                    directory,
                    size: if metadata.is_file() {
                        metadata.len()
                    } else {
                        0
                    },
                },
            );
            if candidates.len() > MAX_LIST_ENTRIES + 1 {
                candidates.pop_last();
                overflow = true;
            }
        }
        let has_more = overflow || candidates.len() > MAX_LIST_ENTRIES;
        let entries = candidates
            .iter()
            .take(MAX_LIST_ENTRIES)
            .map(|(_, entry)| entry.clone())
            .collect::<Vec<_>>();
        let next_cursor = has_more
            .then(|| candidates.keys().nth(MAX_LIST_ENTRIES - 1))
            .flatten()
            .map(encode_cursor)
            .transpose()?;
        Ok(Listing {
            root: self.root.id,
            path: self.relative,
            entries,
            has_more,
            next_cursor,
        })
    }
}

impl SelectionRequest {
    /// Resolve immediately before issuing the grant, outside the async runtime and state mutex.
    pub fn run(self) -> Result<SelectedPath, &'static str> {
        let path = resolve(&self.root, &self.relative)?;
        check_kind(&path, self.kind)?;
        Ok(SelectedPath {
            path,
            kind: self.kind,
            purpose: self.purpose,
        })
    }
}

impl LocateRequest {
    /// Canonicalization may block on a slow filesystem. Run this only through the bounded file
    /// admission pool after cloning the immutable approved roots out of `FileAccess`.
    pub fn run(self) -> Result<LocatedPath, &'static str> {
        let canonical = self.path.canonicalize().map_err(|_| "path unavailable")?;
        let root = self
            .roots
            .iter()
            .filter(|root| canonical.starts_with(&root.path))
            .max_by_key(|root| root.path.components().count())
            .ok_or("path outside approved roots")?;
        let metadata = fs::metadata(&canonical).map_err(|_| "path unavailable")?;
        let directory = if metadata.is_dir() {
            canonical.as_path()
        } else if metadata.is_file() {
            canonical.parent().ok_or("path unavailable")?
        } else {
            return Err("path unavailable");
        };
        let relative = directory
            .strip_prefix(&root.path)
            .map_err(|_| "path outside approved roots")?;
        let path = relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let name = canonical
            .file_name()
            .map(|name| bounded_display_name(&name.to_string_lossy()))
            .unwrap_or_else(|| bounded_display_name(&root.label));
        Ok(LocatedPath {
            root: root.id.clone(),
            path,
            name,
        })
    }
}

fn bounded_display_name(name: &str) -> String {
    let name = name
        .chars()
        .take(255)
        .map(|character| {
            if character.is_control() {
                '\u{fffd}'
            } else {
                character
            }
        })
        .collect::<String>();
    if name.is_empty() {
        "Selected item".to_owned()
    } else {
        name
    }
}

impl EntryKey {
    fn new(directory: bool, name: &str) -> Self {
        Self {
            rank: u8::from(!directory),
            folded: name.to_lowercase(),
            name: name.to_owned(),
        }
    }
}

fn encode_cursor(cursor: &EntryKey) -> Result<String, &'static str> {
    use base64::Engine as _;
    let encoded = serde_json::to_vec(cursor).map_err(|_| "file cursor unavailable")?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(encoded))
}

fn decode_cursor(cursor: &str) -> Result<EntryKey, &'static str> {
    use base64::Engine as _;
    if cursor.is_empty() || cursor.len() > 2048 {
        return Err("invalid file cursor");
    }
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| "invalid file cursor")?;
    let cursor: EntryKey = serde_json::from_slice(&decoded).map_err(|_| "invalid file cursor")?;
    if cursor.rank > 1
        || cursor.name.is_empty()
        || cursor.name.len() > 255
        || cursor.folded != cursor.name.to_lowercase()
        || cursor
            .name
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
    {
        return Err("invalid file cursor");
    }
    Ok(cursor)
}

fn allows(purpose: Purpose, kind: Kind, command: &str) -> bool {
    matches!(
        (purpose, kind, command),
        (
            Purpose::Project,
            Kind::Folder,
            "add_project" | "relink_project" | "github_clone_repo"
        ) | (
            Purpose::Attachment,
            Kind::File,
            "read_document"
                | "import_prompt_image"
                | "import_moodboard_images"
                | "add_moodboard_image"
        ) | (Purpose::Attachment, Kind::Folder, "describe_folder")
            | (Purpose::Theme, Kind::File, "theme_import")
            | (Purpose::Executable, Kind::File, "provider_set_executable")
            | (
                Purpose::Folder,
                Kind::Folder,
                "skills_import_folder" | "describe_folder"
            )
    )
}

fn resolve(root: &Root, relative: &str) -> Result<PathBuf, &'static str> {
    let path = if relative.is_empty() {
        root.path.clone()
    } else {
        validate_relative(relative)?;
        root.path.join(relative)
    };
    let path = path.canonicalize().map_err(|_| "path unavailable")?;
    if !path.starts_with(&root.path) {
        return Err("path escapes approved root");
    }
    Ok(path)
}

fn check_kind(path: &Path, kind: Kind) -> Result<(), &'static str> {
    match kind {
        Kind::File if path.is_file() => Ok(()),
        Kind::Folder if path.is_dir() => Ok(()),
        Kind::File => Err("file required"),
        Kind::Folder => Err("folder required"),
    }
}

fn validate_unchanged(grant: &Grant) -> Result<(), &'static str> {
    let current = grant
        .path
        .canonicalize()
        .map_err(|_| "granted file is unavailable")?;
    if current != grant.path {
        return Err("granted file changed after selection");
    }
    check_kind(&current, grant.kind)
}

pub fn validate_relative_arg(
    args: &serde_json::Value,
    name: &str,
    optional: bool,
) -> Result<(), &'static str> {
    match args.get(name) {
        None | Some(serde_json::Value::Null) if optional => Ok(()),
        Some(serde_json::Value::String(value)) if optional && value.is_empty() => Ok(()),
        Some(serde_json::Value::String(value)) => validate_relative(value),
        _ => Err("relative workspace path required"),
    }
}

pub fn validate_relative_args(args: &serde_json::Value, name: &str) -> Result<(), &'static str> {
    let values = args
        .get(name)
        .and_then(serde_json::Value::as_array)
        .ok_or("relative workspace paths required")?;
    if values.is_empty() || values.len() > 512 {
        return Err("between one and 512 workspace paths required");
    }
    for value in values {
        validate_relative(value.as_str().ok_or("relative workspace paths required")?)?;
    }
    Ok(())
}

pub fn validate_inline_image(args: &serde_json::Value) -> Result<(), &'static str> {
    if args.get("path").is_some_and(|path| !path.is_null()) {
        return Err("host image paths require a file grant");
    }
    let data = args
        .get("dataUrl")
        .and_then(serde_json::Value::as_str)
        .ok_or("inline image required")?;
    if data.len() > MAX_INLINE_IMAGE_BYTES || !data.starts_with("data:image/") {
        return Err("invalid or oversized inline image");
    }
    Ok(())
}

fn validate_relative(relative: &str) -> Result<(), &'static str> {
    let candidate = Path::new(relative);
    if relative.is_empty() || relative.len() > 4096 || candidate.is_absolute() {
        return Err("relative workspace path required");
    }
    if candidate.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("path traversal rejected");
    }
    Ok(())
}

pub fn decode_filename(value: &str) -> Result<String, &'static str> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("invalid upload filename");
            }
            let high = hex(bytes[index + 1]).ok_or("invalid upload filename")?;
            let low = hex(bytes[index + 2]).ok_or("invalid upload filename")?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    let decoded = String::from_utf8(decoded).map_err(|_| "invalid upload filename")?;
    validate_filename(&decoded)?;
    Ok(decoded)
}

fn validate_filename(name: &str) -> Result<(), &'static str> {
    if name.is_empty()
        || name.len() > 255
        || name == "."
        || name == ".."
        || name
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\' | '\0'))
    {
        return Err("invalid upload filename");
    }
    Ok(())
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traversal_and_absolute_paths_are_rejected() {
        assert!(validate_relative("src/main.ts").is_ok());
        assert!(validate_relative("../secret").is_err());
        assert!(validate_relative("/etc/passwd").is_err());
    }

    #[test]
    fn optional_workspace_root_is_empty_but_required_paths_remain_strict() {
        let root = serde_json::json!({"path":""});
        assert!(validate_relative_arg(&root, "path", true).is_ok());
        assert!(validate_relative_arg(&root, "path", false).is_err());
        for path in ["../secret", "/etc/passwd"] {
            assert!(
                validate_relative_arg(&serde_json::json!({"path":path}), "path", true).is_err()
            );
        }
    }

    #[test]
    fn inline_image_rejects_host_paths() {
        assert!(
            validate_inline_image(&serde_json::json!({"path":"/etc/passwd","dataUrl":null}))
                .is_err()
        );
        assert!(validate_inline_image(
            &serde_json::json!({"path":null,"dataUrl":"data:image/png;base64,eA=="})
        )
        .is_ok());
    }

    #[test]
    fn filename_decoder_rejects_separators() {
        assert_eq!(
            decode_filename("hello%20world.png").unwrap(),
            "hello world.png"
        );
        assert!(decode_filename("..%2Fsecret").is_err());
        assert!(decode_filename("%ZZ").is_err());
    }

    #[test]
    fn large_directories_page_stably_without_hiding_late_folders() {
        let base =
            std::env::temp_dir().join(format!("pandacode-file-pages-{}", uuid::Uuid::new_v4()));
        let root = base.join("root");
        fs::create_dir_all(&root).unwrap();
        for index in (0..=MAX_LIST_ENTRIES + 8).rev() {
            fs::create_dir(root.join(format!("folder-{index:04}"))).unwrap();
        }
        for index in 0..8 {
            fs::write(root.join(format!("file-{index:04}.txt")), b"x").unwrap();
        }
        let access = FileAccess::new(
            &[format!("Test={}", root.display())],
            std::iter::empty(),
            base.join("cache"),
        )
        .unwrap();
        let root_id = access.roots()[0].id.clone();
        let first = access.list(&root_id, "", None).unwrap();
        assert_eq!(first.entries.len(), MAX_LIST_ENTRIES);
        assert!(first.has_more && first.entries.iter().all(|entry| entry.directory));
        let second = access
            .list(&root_id, "", first.next_cursor.as_deref())
            .unwrap();
        assert!(!second.has_more);
        assert_eq!(
            first.entries.len() + second.entries.len(),
            MAX_LIST_ENTRIES + 17
        );
        assert!(second.entries.iter().any(|entry| !entry.directory));
        assert_ne!(first.entries.last().unwrap().name, second.entries[0].name);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn locate_chooses_the_deepest_approved_root() {
        let base =
            std::env::temp_dir().join(format!("pandacode-file-locate-{}", uuid::Uuid::new_v4()));
        let outer = base.join("outer");
        let inner = outer.join("inner");
        fs::create_dir_all(&inner).unwrap();
        let file = inner.join("note.txt");
        fs::write(&file, b"inside").unwrap();
        let access = FileAccess::new(
            &[format!("Outer={}", outer.display())],
            [("Inner".to_owned(), inner.clone())],
            base.join("cache"),
        )
        .unwrap();
        let inner_id = access
            .roots
            .values()
            .find(|root| root.label == "Inner")
            .unwrap()
            .id
            .clone();
        let located = access
            .prepare_locate(file.to_string_lossy().as_ref())
            .unwrap()
            .run()
            .unwrap();
        assert_eq!(located.root, inner_id);
        assert_eq!(located.path, "");
        assert_eq!(located.name, "note.txt");
        let _ = fs::remove_dir_all(base);
    }

    #[cfg(unix)]
    #[test]
    fn grants_bind_session_purpose_and_reject_escaping_symlinks() {
        use std::os::unix::fs::symlink;
        let base =
            std::env::temp_dir().join(format!("pandacode-file-grant-{}", uuid::Uuid::new_v4()));
        let root = base.join("root");
        let outside = base.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(root.join("inside.txt"), b"inside").unwrap();
        fs::write(outside.join("secret.txt"), b"secret").unwrap();
        symlink(outside.join("secret.txt"), root.join("escape.txt")).unwrap();
        let mut access = FileAccess::new(
            &[format!("Test={}", root.display())],
            std::iter::empty(),
            base.join("cache"),
        )
        .unwrap();
        let root_id = access.roots()[0].id.clone();
        assert!(access
            .select(
                "session-a",
                &root_id,
                "escape.txt",
                Kind::File,
                Purpose::Attachment,
            )
            .is_err());
        let grant = access
            .select(
                "session-a",
                &root_id,
                "inside.txt",
                Kind::File,
                Purpose::Attachment,
            )
            .unwrap()
            .grant;
        assert!(access
            .materialize("session-b", "read_document", &grant)
            .is_err());
        assert!(access
            .materialize("session-a", "theme_import", &grant)
            .is_err());
        assert!(access
            .materialize("session-a", "read_document", &grant)
            .is_ok());
        assert!(access
            .materialize("session-a", "read_document", &grant)
            .is_err());
        let _ = fs::remove_dir_all(base);
    }
}
