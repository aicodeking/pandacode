//! Exact-resource reads. No directory crawl, Git process, repository config or ambient environment.
use serde_json::{json, Value};
use std::{fs::{self, File}, io::Read, path::{Component, Path, PathBuf}, sync::Arc, time::Instant};

type Result<T> = std::result::Result<T, &'static str>;
pub const CAPABILITIES: [&str; 3] = ["projects.files.metadata", "projects.files.read", "projects.git.read"];
const FILE_LIMIT: usize = 128 * 1024;
const PAGE: usize = 4096;

#[derive(Clone)]
pub struct Authority { root: PathBuf, identity: (u64, u64), _identity_pin: Arc<File> }

fn io(error: std::io::Error) -> &'static str {
    if error.kind() == std::io::ErrorKind::NotFound { "NotFound" } else { "PermissionDenied" }
}
pub fn resource_path(path: &str, git: bool) -> Result<()> {
    if git { return if path == "." { Ok(()) } else { Err("PermissionDenied") }; }
    if path.is_empty() || path.len() > 1024 || path.split('/').count() > 32 { return Err("LimitExceeded"); }
    for part in path.split('/') {
        let lower = part.to_ascii_lowercase();
        let stem = lower.split('.').next().unwrap_or("");
        // Portable grammar also excludes ADS, drive-relative paths, DOS devices and Win32 aliases.
        if part.is_empty() || part.starts_with('.') || part.ends_with(['.', ' ']) || part.chars().any(|c| c.is_control() || "\\:*?\"<>|".contains(c))
            || matches!(stem, "con" | "prn" | "aux" | "nul" | "credentials" | "credential" | "auth" | "secrets" | "secret" | "id_rsa" | "id_ed25519")
            || (stem.len() == 4 && (stem.starts_with("com") || stem.starts_with("lpt")) && stem.as_bytes()[3].is_ascii_digit())
            || lower.ends_with(".pem") || lower.ends_with(".key") { return Err("PermissionDenied"); }
    }
    Ok(())
}

#[cfg(unix)]
fn identity(file: &File) -> Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata().map_err(io)?;
    if !meta.is_dir() && meta.nlink() != 1 { return Err("PermissionDenied"); }
    Ok((meta.dev(), meta.ino()))
}
#[cfg(windows)]
fn identity(file: &File) -> Result<(u64, u64)> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{Foundation::HANDLE, Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION}};
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }.map_err(|_| "PermissionDenied")?;
    if !file.metadata().map_err(io)?.is_dir() && info.nNumberOfLinks != 1 { return Err("PermissionDenied"); }
    Ok((info.dwVolumeSerialNumber as u64, ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64))
}

/// Keep every directory handle until the leaf is consumed. POSIX walks descriptor-relative with
/// O_NOFOLLOW; Windows denies delete sharing, pins ancestors and rejects every reparse point.
struct Opened { chain: Vec<File> }
impl Opened {
    fn file(&self) -> &File { self.chain.last().expect("nonempty pinned chain") }
    fn open(root: &Path, relative: Option<&str>) -> Result<Self> {
        let path = relative.map_or_else(|| root.to_path_buf(), |relative| root.join(relative));
        let mut chain = Vec::new();
        #[cfg(unix)]
        {
            use std::{ffi::CString, os::{fd::{AsRawFd, FromRawFd}, unix::ffi::OsStrExt}};
            chain.push(File::open("/").map_err(io)?);
            let parts: Vec<_> = path.components().filter_map(|part| if let Component::Normal(name) = part { Some(name) } else { None }).collect();
            for (index, part) in parts.iter().enumerate() {
                let name = CString::new(part.as_bytes()).map_err(|_| "PermissionDenied")?;
                let flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK | if index + 1 < parts.len() || relative.is_none() { libc::O_DIRECTORY } else { 0 };
                let fd = unsafe { libc::openat(chain.last().unwrap().as_raw_fd(), name.as_ptr(), flags) };
                if fd < 0 { return Err(io(std::io::Error::last_os_error())); }
                chain.push(unsafe { File::from_raw_fd(fd) });
            }
        }
        #[cfg(windows)]
        {
            use std::{fs::OpenOptions, os::windows::fs::{MetadataExt, OpenOptionsExt}};
            use windows::Win32::Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_ATTRIBUTE_REPARSE_POINT};
            let mut current = PathBuf::new();
            for part in path.components() {
                current.push(part);
                if matches!(part, Component::Prefix(_)) { continue; }
                let file = OpenOptions::new().read(true).share_mode(FILE_SHARE_READ.0 | if current == path && relative.is_some() { 0 } else { FILE_SHARE_WRITE.0 })
                    .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0).open(&current).map_err(io)?;
                if file.metadata().map_err(io)?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 { return Err("PermissionDenied"); }
                chain.push(file);
            }
        }
        if chain.is_empty() { return Err("UnsupportedCapability"); }
        Ok(Self { chain })
    }
}
impl Authority {
    pub fn grant(root: &Path) -> Result<Self> {
        let root = fs::canonicalize(root).map_err(io)?;
        if root.components().any(|part| matches!(part.as_os_str().to_str().map(str::to_ascii_lowercase).as_deref(), Some(".git" | ".ssh" | ".aws" | ".azure" | ".gnupg" | ".kube" | ".codex" | ".claude" | ".opencode"))) { return Err("PermissionDenied"); }
        let opened = Opened::open(&root, None)?;
        if !opened.file().metadata().map_err(io)?.is_dir() { return Err("NotFound"); }
        // Retain the object, not just an inode/file ID that deletion could make reusable. Unlike
        // read-time directory pins this launch-scoped identity handle must permit normal deletion.
        #[cfg(unix)]
        let pin = opened.file().try_clone().map_err(io)?;
        #[cfg(windows)]
        let pin = {
            use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt};
            use windows::Win32::Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_SHARE_DELETE};
            OpenOptions::new().read(true).share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0).open(&root).map_err(io)?
        };
        let identity = identity(opened.file())?;
        if self::identity(&pin)? != identity { return Err("StaleContext"); }
        Ok(Self { root, identity, _identity_pin: Arc::new(pin) })
    }
    fn open(&self, current: &Path, relative: &str) -> Result<Opened> {
        if fs::canonicalize(current).map_err(io)? != self.root { return Err("StaleContext"); }
        let root = Opened::open(&self.root, None)?;
        if identity(root.file())? != self.identity { return Err("StaleContext"); }
        let opened = Opened::open(&self.root, Some(relative))?;
        // Check the root in the actual leaf chain as well, not only a path checked before opening.
        let index = root.chain.len() - 1;
        if identity(opened.chain.get(index).ok_or("PermissionDenied")?)? != self.identity { return Err("StaleContext"); }
        identity(opened.file())?;
        Ok(opened)
    }
}
fn check(deadline: Instant, cancelled: &impl Fn() -> bool) -> Result<()> {
    if cancelled() { Err("Cancelled") } else if Instant::now() >= deadline { Err("Timeout") } else { Ok(()) }
}
fn bytes(opened: &Opened, limit: usize, deadline: Instant, cancelled: &impl Fn() -> bool) -> Result<Vec<u8>> {
    let file = opened.file(); let before = file.metadata().map_err(io)?;
    if !before.is_file() { return Err("UnsupportedCapability"); }
    #[cfg(unix)]
    { use std::os::unix::fs::MetadataExt; if before.nlink() != 1 { return Err("PermissionDenied"); } }
    if before.len() > limit as u64 { return Err("LimitExceeded"); }
    let mut content = Vec::new(); let mut reader = file.take(limit as u64 + 1);
    loop {
        check(deadline, cancelled)?;
        let mut buffer = [0; 4096]; let count = reader.read(&mut buffer).map_err(io)?;
        if count == 0 { break; } content.extend_from_slice(&buffer[..count]);
    }
    let after = file.metadata().map_err(io)?;
    if content.len() > limit { return Err("LimitExceeded"); }
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() { return Err("StaleContext"); }
    check(deadline, cancelled)?; Ok(content)
}
pub fn query(authority: &Authority, root: &Path, resource: &str, path: &str, page: (u32, Option<&str>), deadline: Instant, cancelled: impl Fn() -> bool) -> Result<Value> {
    let (cursor, expected) = page;
    check(deadline, &cancelled)?;
    resource_path(path, resource == "git")?;
    if cursor > FILE_LIMIT as u32 || expected.is_some_and(|revision| revision.len() > 64) { return Err("LimitExceeded"); }
    if cursor > 0 && expected.is_none() { return Err("StaleContext"); }
    let (items, content, revision) = match resource {
        "metadata" | "file" => {
            let opened = authority.open(root, path)?;
            let meta = opened.file().metadata().map_err(io)?;
            if !meta.is_file() { return Err("UnsupportedCapability"); }
            if resource == "metadata" {
                if cursor != 0 { return Err("InvalidShape"); }
                let revision = fingerprint(format!("{:?}:{:?}:{}", identity(opened.file())?, meta.modified().ok(), meta.len()).as_bytes());
                (json!([{"path":path,"bytes":meta.len(),"kind":"file"}]), None, revision)
            } else {
                let data = bytes(&opened, FILE_LIMIT, deadline, &cancelled)?;
                if data.contains(&0) { return Err("UnsupportedCapability"); }
                let text = String::from_utf8(data).map_err(|_| "UnsupportedCapability")?;
                let revision = fingerprint(text.as_bytes());
                (json!([]), Some(text), revision)
            }
        }
        "git" => {
            if cursor != 0 { return Err("InvalidShape"); }
            // Only HEAD is public: never config/remotes, hooks, credentials, logs or external gitdir.
            let opened = authority.open(root, ".git/HEAD")?;
            let data = bytes(&opened, 1024, deadline, &cancelled)?;
            let head = std::str::from_utf8(&data).map_err(|_| "UnsupportedCapability")?.trim();
            let (branch, commit) = if let Some(branch) = head.strip_prefix("ref: refs/heads/") {
                if branch.is_empty() || branch.len() > 256 || branch.contains("..") || branch.split('/').any(|part| part.is_empty() || part.starts_with('.') || part.ends_with('.') || part.ends_with(".lock")) || !branch.chars().all(|c| c.is_ascii_alphanumeric() || "/-_.".contains(c)) { return Err("UnsupportedCapability"); }
                (Some(branch), None)
            } else if [40, 64].contains(&head.len()) && head.bytes().all(|c| c.is_ascii_hexdigit()) { (None, Some(head)) }
            else { return Err("UnsupportedCapability"); };
            (json!([{"kind":"head","branch":branch,"commit":commit}]), None, fingerprint(&data))
        }
        _ => return Err("UnsupportedCapability"),
    };
    if expected.is_some_and(|expected| expected != revision) { return Err("StaleContext"); }
    let mut next = None;
    let content = if let Some(text) = content {
        let start = cursor as usize;
        if start > text.len() || !text.is_char_boundary(start) { return Err("InvalidShape"); }
        let mut end = (start + PAGE).min(text.len()); while !text.is_char_boundary(end) { end -= 1; }
        if end < text.len() { next = Some(end); }
        Some(text[start..end].to_owned())
    } else { None };
    check(deadline, &cancelled)?;
    Ok(json!({"schemaVersion":1,"state":"Ready","revision":revision,"items":items,"content":content,"nextCursor":next}))
}
fn fingerprint(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256}; format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture { base: PathBuf, root: PathBuf, other: PathBuf }
    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!("panda-extension-reads-{}", uuid::Uuid::new_v4()));
            let root = base.join("root"); let other = base.join("other");
            fs::create_dir_all(&root).unwrap(); fs::create_dir_all(&other).unwrap();
            fs::write(root.join("readme.txt"), "authorized text").unwrap(); fs::write(other.join("readme.txt"), "OUTSIDE_SECRET").unwrap();
            Self { base, root, other }
        }
        fn query(&self, authority: &Authority, resource: &str, path: &str, cursor: u32, revision: Option<&str>) -> Result<Value> {
            query(authority, &self.root, resource, path, (cursor, revision), Instant::now() + std::time::Duration::from_secs(2), || false)
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.base); } }
    #[test]
    fn portable_paths_block_traversal_alternate_separators_absolute_ads_devices_and_auth() {
        for path in ["../outside", "a/../b", "a\\..\\b", "/etc/passwd", "C:/file", "C:file", "\\\\server\\share", "a//b", "./a", "a/", "a\0b", ".git/config", ".env", "a/.ssh/key", "AUTH.json", "credentials.json", "server.pem", "private.key", "a:stream", "CON.txt", "LPT1", "a.", "a "] { assert!(resource_path(path, false).is_err(), "{path}"); }
        assert!(resource_path("src/readme.md", false).is_ok()); assert!(resource_path(".", true).is_ok());
        assert!(resource_path(".git/config", true).is_err());
    }
    #[test]
    fn bounded_text_metadata_utf8_pagination_binary_large_stale_and_cancelled() {
        let f = Fixture::new(); let authority = Authority::grant(&f.root).unwrap();
        assert_eq!(f.query(&authority, "metadata", "readme.txt", 0, None).unwrap()["items"], json!([{"path":"readme.txt","bytes":15,"kind":"file"}]));
        fs::write(f.root.join("readme.txt"), "€".repeat(2000)).unwrap();
        let first = f.query(&authority, "file", "readme.txt", 0, None).unwrap();
        assert_eq!(first["content"].as_str().unwrap().len(), 4095); assert_eq!(first["nextCursor"], 4095);
        assert_eq!(f.query(&authority, "file", "readme.txt", 4095, first["revision"].as_str()).unwrap()["content"].as_str().unwrap().len(), 1905);
        assert_eq!(f.query(&authority, "file", "readme.txt", 4095, None).unwrap_err(), "StaleContext");
        assert_eq!(f.query(&authority, "file", "readme.txt", 1, first["revision"].as_str()).unwrap_err(), "InvalidShape");
        fs::write(f.root.join("readme.txt"), "changed").unwrap();
        assert_eq!(f.query(&authority, "file", "readme.txt", 0, first["revision"].as_str()).unwrap_err(), "StaleContext");
        for data in [vec![0, 1, 2], vec![255, 254]] { fs::write(f.root.join("readme.txt"), data).unwrap(); assert_eq!(f.query(&authority, "file", "readme.txt", 0, None).unwrap_err(), "UnsupportedCapability"); }
        fs::write(f.root.join("readme.txt"), vec![b'x'; FILE_LIMIT + 1]).unwrap();
        assert_eq!(f.query(&authority, "file", "readme.txt", 0, None).unwrap_err(), "LimitExceeded");
        assert!(f.query(&authority, "metadata", "readme.txt", 0, None).is_ok());
        assert_eq!(query(&authority, &f.root, "file", "readme.txt", (0, None), Instant::now(), || true).unwrap_err(), "Cancelled");
        assert_eq!(query(&authority, &f.root, "file", "readme.txt", (0, None), Instant::now(), || false).unwrap_err(), "Timeout");
        fs::write(f.root.join("readme.txt"), "small").unwrap();
        let calls = std::cell::Cell::new(0);
        assert_eq!(query(&authority, &f.root, "file", "readme.txt", (0, None), Instant::now() + std::time::Duration::from_secs(2), || { calls.set(calls.get() + 1); calls.get() > 1 }).unwrap_err(), "Cancelled");
    }
    #[test]
    fn deleted_roots_root_identity_substitution_project_path_changes_and_hardlinks_fail_closed() {
        let f = Fixture::new(); let authority = Authority::grant(&f.root).unwrap();
        assert_eq!(query(&authority, &f.other, "file", "readme.txt", (0, None), Instant::now() + std::time::Duration::from_secs(2), || false).unwrap_err(), "StaleContext");
        fs::hard_link(f.other.join("readme.txt"), f.root.join("alias.txt")).unwrap();
        assert_eq!(f.query(&authority, "file", "alias.txt", 0, None).unwrap_err(), "PermissionDenied");
        fs::rename(&f.root, f.base.join("moved")).unwrap();
        assert_eq!(f.query(&authority, "file", "readme.txt", 0, None).unwrap_err(), "NotFound");
        fs::create_dir(&f.root).unwrap(); fs::write(f.root.join("readme.txt"), "replacement").unwrap();
        assert_eq!(f.query(&authority, "file", "readme.txt", 0, None).unwrap_err(), "StaleContext");
    }
    #[test]
    fn git_head_is_a_fixed_read_not_config_environment_hooks_external_gitdir_or_mutation() {
        let f = Fixture::new(); let authority = Authority::grant(&f.root).unwrap();
        fs::create_dir(f.root.join(".git")).unwrap();
        fs::write(f.root.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::write(f.root.join(".git/config"), "AUTH_TOKEN_SENTINEL").unwrap();
        let value = f.query(&authority, "git", ".", 0, None).unwrap();
        assert_eq!(value["items"], json!([{"kind":"head","branch":"main","commit":null}])); assert!(!value.to_string().contains("TOKEN"));
        assert_eq!(fs::read_to_string(f.root.join(".git/config")).unwrap(), "AUTH_TOKEN_SENTINEL");
        fs::write(f.root.join(".git/HEAD"), "a".repeat(40)).unwrap();
        assert_eq!(f.query(&authority, "git", ".", 0, value["revision"].as_str()).unwrap_err(), "StaleContext");
        assert_eq!(f.query(&authority, "git", ".", 0, None).unwrap()["items"][0]["commit"], "a".repeat(40));
        fs::write(f.root.join(".git/HEAD"), "ref: refs/heads/../../config").unwrap();
        // Invalid branch syntax never becomes another file read.
        assert_eq!(f.query(&authority, "git", ".", 0, None).unwrap_err(), "UnsupportedCapability");
        assert_eq!(f.query(&authority, "git", ".git/config", 0, None).unwrap_err(), "PermissionDenied");
        fs::rename(f.root.join(".git"), f.root.join("private-git")).unwrap();
        fs::write(f.root.join(".git"), format!("gitdir: {}", f.other.display())).unwrap();
        assert!(f.query(&authority, "git", ".", 0, None).is_err());
        assert!(query(&authority, &f.root, "commit", ".", (0, None), Instant::now() + std::time::Duration::from_secs(2), || false).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_and_post_open_parent_substitution_cannot_escape_descriptor_root() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new(); let authority = Authority::grant(&f.root).unwrap();
        symlink(&f.other, f.root.join("escape")).unwrap();
        assert!(f.query(&authority, "file", "escape/readme.txt", 0, None).is_err());
        symlink(f.other.join("readme.txt"), f.root.join("alias.txt")).unwrap();
        assert!(f.query(&authority, "file", "alias.txt", 0, None).is_err());
        let opened = authority.open(&f.root, "readme.txt").unwrap();
        fs::rename(&f.root, f.base.join("moved")).unwrap(); symlink(&f.other, &f.root).unwrap();
        assert_eq!(bytes(&opened, FILE_LIMIT, Instant::now() + std::time::Duration::from_secs(2), &|| false).unwrap(), b"authorized text");
        assert!(f.query(&authority, "file", "readme.txt", 0, None).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn junction_escape_and_post_open_parent_rename_are_rejected_on_windows() {
        use std::os::windows::process::CommandExt;
        let f = Fixture::new(); let authority = Authority::grant(&f.root).unwrap();
        let junction = f.root.join("escape");
        let result = std::process::Command::new("cmd.exe").args(["/d", "/c", "mklink", "/J"]).arg(&junction).arg(&f.other).creation_flags(0x08000000).output().unwrap();
        assert!(result.status.success(), "junction fixture must actually exist");
        assert_eq!(f.query(&authority, "file", "escape/readme.txt", 0, None).unwrap_err(), "PermissionDenied");
        let opened = authority.open(&f.root, "readme.txt").unwrap();
        assert!(fs::rename(&f.root, f.base.join("moved")).is_err());
        assert_eq!(bytes(&opened, FILE_LIMIT, Instant::now() + std::time::Duration::from_secs(2), &|| false).unwrap(), b"authorized text");
        drop(opened); fs::remove_dir(&junction).unwrap();
    }
}
