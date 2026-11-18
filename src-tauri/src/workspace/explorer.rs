//! Project-scoped create, rename, delete and save for the file explorer.
//!
//! Mutations stay inside the checkout: the relative path may only contain normal
//! components (no `..`, absolute paths or `.git`), and on Unix each step is
//! `openat` with `O_NOFOLLOW`. A symlink cannot redirect a write or a delete
//! outside the project. Deleting a symlink removes that link, not its target, and a
//! directory delete unlinks a nested symlink without following it.

use super::{scoped_path, FILE_LIMIT};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};
#[cfg(not(unix))]
use std::{
    fs::File,
    io::{Read, Write},
};

static EDITS: Mutex<()> = Mutex::new(());

pub(super) const ESCAPE: &str = "Choose a file or folder inside the project.";
pub(super) const SYMLINK: &str = "Symbolic links cannot be changed in the explorer.";
pub(super) const EXISTS: &str = "A file or folder with that name already exists.";
pub(super) const NAME: &str = "Enter a single file or folder name.";
pub(super) const STALE: &str = "File changed on disk. Copy your edits, then reload before saving.";

pub(super) fn leaf_ok(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0', ':']) {
        return false;
    }
    if name.eq_ignore_ascii_case(".git") {
        return false;
    }
    #[cfg(windows)]
    {
        if name.ends_with([' ', '.']) {
            return false;
        }
        let stem = name.split('.').next().unwrap_or(name);
        const RESERVED: &[&str] = &[
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ];
        if RESERVED.iter().any(|item| stem.eq_ignore_ascii_case(item)) {
            return false;
        }
    }
    true
}

/// A relative project path: normal components only, and nothing that names `.git`
/// (any case) or a Windows alternate data stream.
pub(super) fn validate_relative(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 4096 || path.contains('\0') {
        return Err(ESCAPE.into());
    }
    let mut any = false;
    for part in Path::new(path).components() {
        let Component::Normal(name) = part else {
            return Err(ESCAPE.into());
        };
        any = true;
        if !leaf_ok(&name.to_string_lossy()) {
            return Err(ESCAPE.into());
        }
    }
    if !any {
        return Err(ESCAPE.into());
    }
    Ok(())
}

pub(super) fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(root).map_err(|e| e.to_string())
}

/// The file the OS may open: a regular file whose canonical path is inside `root`.
/// Symlinks are followed only to confirm the target stays in the project; the returned
/// path is that canonical file, never the link.
pub fn openable_file(root: &Path, path: &str) -> Result<PathBuf, String> {
    validate_relative(path)?;
    let root = canonical_root(root)?;
    let target = scoped_path(&root, path)?;
    let resolved = fs::canonicalize(&target).map_err(|e| e.to_string())?;
    if !resolved.starts_with(&root) {
        return Err("Symlink points outside the project".into());
    }
    let meta = fs::symlink_metadata(&resolved).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err("Choose an existing file.".into());
    }
    Ok(resolved)
}

fn copy_path(root: &Path, path: &str) -> Result<String, String> {
    let root = canonical_root(root)?;
    if path.is_empty() {
        return Ok(root.to_string_lossy().into_owned());
    }
    validate_relative(path)?;
    let target = scoped_path(&root, path)?;
    let resolved = fs::canonicalize(&target).map_err(|e| e.to_string())?;
    if !resolved.starts_with(&root) {
        return Err("Symlink points outside the project".into());
    }
    Ok(resolved.to_string_lossy().into_owned())
}

pub fn manage_entry(
    root: &Path,
    action: &str,
    path: &str,
    name: Option<&str>,
) -> Result<String, String> {
    if action == "path" {
        return copy_path(root, path);
    }
    let _guard = EDITS.lock().map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        manage_unix(root, action, path, name)
    }
    #[cfg(not(unix))]
    {
        manage_fallback(root, action, path, name)
    }
}

pub fn file_stamp(root: &Path, path: &str) -> Result<String, String> {
    let resolved = openable_file(root, path)?;
    let meta = fs::metadata(&resolved).map_err(|e| e.to_string())?;
    let modified = meta
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    Ok(format!("{}:{}", meta.len(), modified.as_nanos()))
}

pub fn write_file(root: &Path, path: &str, content: &str, expected: &str) -> Result<(), String> {
    if content.len() > FILE_LIMIT || content.contains('\0') {
        return Err("Text files must be UTF-8 and no larger than 128 KiB.".into());
    }
    let _guard = EDITS.lock().map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        write_unix(root, path, content, expected)
    }
    #[cfg(not(unix))]
    {
        write_fallback(root, path, content, expected)
    }
}

#[cfg(unix)]
mod unix_edit {
    use super::{canonical_root, leaf_ok, validate_relative, ESCAPE, EXISTS, FILE_LIMIT, NAME, STALE, SYMLINK};
    use std::{
        ffi::{CStr, CString},
        fs::{self, File},
        io::{Read, Seek, SeekFrom, Write},
        os::fd::{AsRawFd, FromRawFd},
        os::unix::fs::OpenOptionsExt,
        path::{Path, PathBuf},
    };

    pub(super) fn manage_unix(
        root: &Path,
        action: &str,
        path: &str,
        name: Option<&str>,
    ) -> Result<String, String> {
        validate_relative(path)?;
        let (parent, leaf) = open_parent(root, path)?;
        let leaf_c = c_name(&leaf)?;
        match action {
            "new-file" => {
                let file = create_file(&parent, &leaf_c)?;
                drop(file);
                Ok(path.into())
            }
            "new-folder" => {
                mkdir(&parent, &leaf_c)?;
                Ok(path.into())
            }
            "rename" => {
                let name = name.ok_or(NAME)?;
                if !leaf_ok(name) {
                    return Err(NAME.into());
                }
                let parent_path = path.rsplit_once('/').map(|(head, _)| head).unwrap_or("");
                let renamed = if parent_path.is_empty() {
                    name.to_string()
                } else {
                    format!("{parent_path}/{name}")
                };
                validate_relative(&renamed)?;
                if renamed == path {
                    return Ok(path.into());
                }
                let dest = c_name(name)?;
                if let Some(error) = exists(&parent, &dest) {
                    return Err(error);
                }
                rename_exclusive(&parent, &leaf_c, &dest)?;
                Ok(renamed)
            }
            "delete" => {
                delete_at(root, &parent, &leaf_c)?;
                Ok(path.into())
            }
            _ => Err("Unknown file operation.".into()),
        }
    }

    pub(super) fn write_unix(root: &Path, path: &str, content: &str, expected: &str) -> Result<(), String> {
        validate_relative(path)?;
        let (parent, leaf) = open_parent(root, path)?;
        let leaf_c = c_name(&leaf)?;
        let mut current = open_file(&parent, &leaf_c)?;
        if read_text(&mut current)? != expected {
            return Err(STALE.into());
        }
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            current.metadata().map_err(|e| e.to_string())?.permissions().mode() & 0o7777
        };
        let temp = format!(".pandacode-save-{}", uuid::Uuid::new_v4());
        let temp_c = c_name(&temp)?;
        let mut file = create_file(&parent, &temp_c)?;
        let result = (|| {
            file.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            current.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
            if read_text(&mut current)? != expected {
                return Err(STALE.into());
            }
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(mode)).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            rename_replace(&parent, &temp_c, &leaf_c)
        })();
        if result.is_err() {
            let _ = unlink(&parent, &temp_c, false);
        }
        result
    }

    fn c_name(name: &str) -> Result<CString, String> {
        CString::new(name.as_bytes()).map_err(|_| ESCAPE.into())
    }

    fn open_directory(path: &Path) -> Result<File, String> {
        fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
            .open(path)
            .map_err(|e| e.to_string())
    }

    fn open_parent(root: &Path, path: &str) -> Result<(File, String), String> {
        let mut dir = open_directory(root)?;
        confirm_inside(root, &dir)?;
        let mut parts = path.split('/');
        let leaf = parts.next_back().ok_or(ESCAPE)?.to_string();
        for part in parts {
            let name = c_name(part)?;
            dir = openat_dir(&dir, &name)?;
            confirm_inside(root, &dir)?;
        }
        Ok((dir, leaf))
    }

    fn openat_dir(dir: &File, name: &CStr) -> Result<File, String> {
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            // Linux returns ENOTDIR, not ELOOP, for O_DIRECTORY|O_NOFOLLOW on a symlink.
            if error.raw_os_error() == Some(libc::ENOTDIR) && matches!(node_kind(dir, name), Ok(Node::Symlink)) {
                return Err(SYMLINK.into());
            }
            return Err(io_message(error));
        }
        owned_fd(fd)
    }

    fn open_file(dir: &File, name: &CStr) -> Result<File, String> {
        match node_kind(dir, name)? {
            Node::File => {}
            Node::Symlink => return Err(SYMLINK.into()),
            Node::Directory | Node::Other => return Err("Only regular text files can be edited.".into()),
        }
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        let file = owned_fd(fd)?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err("Only regular text files can be edited.".into());
        }
        Ok(file)
    }

    fn create_file(dir: &File, name: &CStr) -> Result<File, String> {
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_WRONLY | libc::O_CLOEXEC,
                0o644,
            )
        };
        owned_fd(fd)
    }

    fn owned_fd(fd: libc::c_int) -> Result<File, String> {
        if fd < 0 {
            return Err(io_message(std::io::Error::last_os_error()));
        }
        // SAFETY: fd is a fresh descriptor from openat/open, and File closes it.
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    fn mkdir(dir: &File, name: &CStr) -> Result<(), String> {
        let rc = unsafe { libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), 0o755) };
        if rc != 0 {
            return Err(io_message(std::io::Error::last_os_error()));
        }
        Ok(())
    }

    fn exists(dir: &File, name: &CStr) -> Option<String> {
        let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
        let rc = unsafe { libc::fstatat(dir.as_raw_fd(), name.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) };
        if rc == 0 {
            Some(EXISTS.into())
        } else {
            None
        }
    }

    fn rename_exclusive(dir: &File, from: &CStr, to: &CStr) -> Result<(), String> {
        // Linux and macOS refuse to replace via renameat2 / renameatx_np. Other Unix has no
        // exclusive flag, so reject an existing destination before renameat.
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        if exists(dir, to).is_some() {
            return Err(EXISTS.into());
        }
        let rc = rename_no_replace(dir, from, to);
        if rc != 0 {
            return Err(io_message(std::io::Error::last_os_error()));
        }
        Ok(())
    }

    fn rename_replace(dir: &File, from: &CStr, to: &CStr) -> Result<(), String> {
        // SAFETY: both names are NUL-terminated and the descriptor is a directory we opened.
        let rc = unsafe { libc::renameat(dir.as_raw_fd(), from.as_ptr(), dir.as_raw_fd(), to.as_ptr()) };
        if rc != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn rename_no_replace(dir: &File, from: &CStr, to: &CStr) -> libc::c_int {
        // SAFETY: names are NUL-terminated; RENAME_NOREPLACE refuses to clobber the destination.
        unsafe {
            libc::renameat2(
                dir.as_raw_fd(),
                from.as_ptr(),
                dir.as_raw_fd(),
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        }
    }

    #[cfg(target_os = "macos")]
    fn rename_no_replace(dir: &File, from: &CStr, to: &CStr) -> libc::c_int {
        // SAFETY: names are NUL-terminated; RENAME_EXCL refuses to clobber the destination.
        unsafe {
            libc::renameatx_np(
                dir.as_raw_fd(),
                from.as_ptr(),
                dir.as_raw_fd(),
                to.as_ptr(),
                libc::RENAME_EXCL,
            )
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn rename_no_replace(dir: &File, from: &CStr, to: &CStr) -> libc::c_int {
        // SAFETY: names are NUL-terminated and the descriptor is the parent directory.
        // The caller already rejected an existing destination.
        unsafe { libc::renameat(dir.as_raw_fd(), from.as_ptr(), dir.as_raw_fd(), to.as_ptr()) }
    }

    fn delete_at(root: &Path, dir: &File, name: &CStr) -> Result<(), String> {
        match node_kind(dir, name)? {
            // Unlink the directory entry. unlinkat does not follow a symlink, so the target stays.
            Node::Symlink | Node::File | Node::Other => unlink(dir, name, false),
            Node::Directory => {
                let child = openat_dir(dir, name)?;
                confirm_inside(root, &child)?;
                remove_children(root, &child)?;
                unlink(dir, name, true)
            }
        }
    }

    enum Node {
        Directory,
        Symlink,
        File,
        Other,
    }

    fn node_kind(dir: &File, name: &CStr) -> Result<Node, String> {
        let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
        let rc = unsafe { libc::fstatat(dir.as_raw_fd(), name.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) };
        if rc != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let kind = stat.st_mode & libc::S_IFMT;
        if kind == libc::S_IFLNK {
            Ok(Node::Symlink)
        } else if kind == libc::S_IFDIR {
            Ok(Node::Directory)
        } else if kind == libc::S_IFREG {
            Ok(Node::File)
        } else {
            Ok(Node::Other)
        }
    }

    fn unlink(dir: &File, name: &CStr, directory: bool) -> Result<(), String> {
        let flags = if directory { libc::AT_REMOVEDIR } else { 0 };
        // SAFETY: name is NUL-terminated. AT_REMOVEDIR removes an empty directory entry, not a link target.
        let rc = unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), flags) };
        if rc != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }

    fn remove_children(root: &Path, dir: &File) -> Result<(), String> {
        let dup = unsafe { libc::dup(dir.as_raw_fd()) };
        if dup < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        // SAFETY: dup is a live descriptor. fdopendir takes ownership of it.
        let listing = unsafe { libc::fdopendir(dup) };
        if listing.is_null() {
            unsafe { libc::close(dup) };
            return Err(std::io::Error::last_os_error().to_string());
        }
        let mut names = Vec::new();
        loop {
            clear_errno();
            // SAFETY: listing is an open DIR from fdopendir, and we copy the name before the next read.
            let entry = unsafe { libc::readdir(listing) };
            if entry.is_null() {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error().unwrap_or(0) != 0 {
                    unsafe { libc::closedir(listing) };
                    return Err(error.to_string());
                }
                break;
            }
            // SAFETY: readdir's d_name is a NUL-terminated name valid until the next readdir.
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            names.push(name.to_owned());
        }
        // SAFETY: listing came from fdopendir and has not been closed.
        unsafe { libc::closedir(listing) };
        for name in names {
            match node_kind(dir, &name)? {
                Node::Symlink | Node::File | Node::Other => unlink(dir, &name, false)?,
                Node::Directory => {
                    let child = openat_dir(dir, &name)?;
                    confirm_inside(root, &child)?;
                    remove_children(root, &child)?;
                    unlink(dir, &name, true)?;
                }
            }
        }
        Ok(())
    }

    fn read_text(file: &mut File) -> Result<String, String> {
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err("Only regular text files can be edited.".into());
        }
        if meta.len() > FILE_LIMIT as u64 {
            return Err("File exceeds the 128 KiB preview limit".into());
        }
        let mut bytes = Vec::new();
        file.take(FILE_LIMIT as u64 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if bytes.len() > FILE_LIMIT {
            return Err("File exceeds the 128 KiB preview limit".into());
        }
        if bytes.contains(&0) {
            return Err("Binary files cannot be edited as text.".into());
        }
        String::from_utf8(bytes).map_err(|_| "File is not UTF-8 text".into())
    }

    fn io_message(error: std::io::Error) -> String {
        match error.raw_os_error() {
            Some(code) if code == libc::ELOOP => SYMLINK.into(),
            Some(code) if code == libc::EEXIST => EXISTS.into(),
            Some(code) if code == libc::ENOTDIR => "Not a directory".into(),
            _ => error.to_string(),
        }
    }

    #[cfg(target_os = "linux")]
    fn clear_errno() {
        // SAFETY: __errno_location is thread-local and the write is a single c_int.
        unsafe { *libc::__errno_location() = 0 };
    }

    #[cfg(target_os = "macos")]
    fn clear_errno() {
        // SAFETY: __error is thread-local and the write is a single c_int.
        unsafe { *libc::__error() = 0 };
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn clear_errno() {}

    #[cfg(target_os = "macos")]
    fn opened_path(file: &File) -> Option<PathBuf> {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let mut buffer = vec![0u8; libc::PATH_MAX as usize];
        // SAFETY: F_GETPATH writes at most PATH_MAX bytes, NUL-terminated, into the buffer.
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) } == -1 {
            return None;
        }
        let len = buffer.iter().position(|byte| *byte == 0)?;
        Some(PathBuf::from(OsStr::from_bytes(&buffer[..len])))
    }

    #[cfg(target_os = "linux")]
    fn opened_path(file: &File) -> Option<PathBuf> {
        fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).ok()
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn opened_path(_file: &File) -> Option<PathBuf> {
        None
    }

    fn confirm_inside(root: &Path, file: &File) -> Result<(), String> {
        let root = canonical_root(root)?;
        let Some(opened) = opened_path(file) else {
            return if cfg!(any(target_os = "linux", target_os = "macos")) {
                Err("Could not confirm the project path.".into())
            } else {
                Ok(())
            };
        };
        let opened = fs::canonicalize(&opened).unwrap_or(opened);
        if opened.starts_with(&root) {
            Ok(())
        } else {
            Err(ESCAPE.into())
        }
    }
}

#[cfg(unix)]
use unix_edit::{manage_unix, write_unix};

#[cfg(not(unix))]
fn editable_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    validate_relative(path)?;
    let target = scoped_path(root, path)?;
    let mut ancestor = target.as_path();
    while ancestor != root {
        if fs::symlink_metadata(ancestor).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(SYMLINK.into());
        }
        ancestor = ancestor.parent().ok_or(ESCAPE)?;
    }
    Ok(target)
}

#[cfg(not(unix))]
fn manage_fallback(root: &Path, action: &str, path: &str, name: Option<&str>) -> Result<String, String> {
    let target = editable_path(root, path)?;
    match action {
        "new-file" => {
            fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|e| e.to_string())?;
        }
        "new-folder" => fs::create_dir(&target).map_err(|e| e.to_string())?,
        "rename" => {
            let name = name.ok_or(NAME)?;
            if !leaf_ok(name) {
                return Err(NAME.into());
            }
            let parent = path.rsplit_once('/').map(|(head, _)| head).unwrap_or("");
            let renamed = if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") };
            let destination = editable_path(root, &renamed)?;
            if target == destination {
                return Ok(path.into());
            }
            if fs::symlink_metadata(&destination).is_ok() {
                return Err(EXISTS.into());
            }
            rename_no_replace(&target, &destination)?;
            return Ok(renamed);
        }
        "delete" => {
            let meta = fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
            if meta.file_type().is_symlink() {
                // Remove the link itself. remove_file does not follow it.
                fs::remove_file(&target).map_err(|e| e.to_string())?;
            } else if meta.is_dir() {
                fs::remove_dir_all(target).map_err(|e| e.to_string())?;
            } else {
                fs::remove_file(target).map_err(|e| e.to_string())?;
            }
        }
        _ => return Err("Unknown file operation.".into()),
    }
    Ok(path.into())
}

#[cfg(not(unix))]
fn rename_no_replace(from: &Path, to: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // MoveFileW fails when the destination already exists, so a rename cannot clobber a file.
    unsafe {
        windows::Win32::Storage::FileSystem::MoveFileW(
            windows::core::PCWSTR(from.as_ptr()),
            windows::core::PCWSTR(to.as_ptr()),
        )
    }
    .map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn write_fallback(root: &Path, path: &str, content: &str, expected: &str) -> Result<(), String> {
    let target = editable_path(root, path)?;
    let meta = fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(SYMLINK.into());
    }
    if read_text_path(&target)? != expected {
        return Err(STALE.into());
    }
    let mode = meta.permissions();
    let temporary = target.with_file_name(format!(".pandacode-save-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|e| e.to_string())?;
        file.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        if fs::symlink_metadata(&target).map_err(|e| e.to_string())?.file_type().is_symlink() {
            return Err(SYMLINK.into());
        }
        if read_text_path(&target)? != expected {
            return Err(STALE.into());
        }
        file.set_permissions(mode).map_err(|e| e.to_string())?;
        fs::rename(&temporary, &target).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[cfg(not(unix))]
fn read_text_path(path: &Path) -> Result<String, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(SYMLINK.into());
    }
    if meta.len() > FILE_LIMIT as u64 {
        return Err("File exceeds the 128 KiB preview limit".into());
    }
    let file = File::open(path).map_err(|e| e.to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > FILE_LIMIT as u64 {
        return Err("Only regular text files can be edited.".into());
    }
    let mut bytes = Vec::new();
    file.take(FILE_LIMIT as u64 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > FILE_LIMIT || bytes.contains(&0) {
        return Err("Binary files cannot be edited as text.".into());
    }
    String::from_utf8(bytes).map_err(|_| "File is not UTF-8 text".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("pandacode-explorer-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn explorer_manages_entries_without_overwriting() {
        let f = Fixture::new();
        let root = &f.0;
        manage_entry(root, "new-folder", "assets", None).unwrap();
        for name in ["code.ts", "config", "image.png", "report.pdf"] {
            let path = format!("assets/{name}");
            manage_entry(root, "new-file", &path, None).unwrap();
            assert!(manage_entry(root, "new-file", &path, None).is_err());
        }
        fs::write(root.join("assets/image.png"), [0, 137, 80]).unwrap();
        assert!(manage_entry(root, "rename", "assets/code.ts", Some("image.png")).is_err());
        assert_eq!(manage_entry(root, "rename", "assets", Some("media")).unwrap(), "media");
        assert_eq!(fs::read(root.join("media/image.png")).unwrap(), [0, 137, 80]);
        manage_entry(root, "delete", "media", None).unwrap();
        assert!(!root.join("media").exists());
    }

    #[test]
    fn explorer_saves_text_and_rejects_stale_edits() {
        let f = Fixture::new();
        let root = &f.0;
        manage_entry(root, "new-file", "notes.md", None).unwrap();
        let before = file_stamp(root, "notes.md").unwrap();
        write_file(root, "notes.md", "# Hello 🐼\n", "").unwrap();
        assert_ne!(before, file_stamp(root, "notes.md").unwrap());
        assert!(write_file(root, "notes.md", "lost", "").unwrap_err().contains("changed on disk"));
        assert_eq!(read_file_text(root, "notes.md"), "# Hello 🐼\n");
        assert!(write_file(root, "notes.md", &"x".repeat(FILE_LIMIT + 1), "# Hello 🐼\n").is_err());
        assert!(write_file(root, "notes.md", "\0", "# Hello 🐼\n").is_err());
        assert!(root.read_dir().unwrap().all(|entry| {
            !entry.unwrap().file_name().to_string_lossy().starts_with(".pandacode-save-")
        }));
    }

    fn read_file_text(root: &Path, path: &str) -> String {
        fs::read_to_string(root.join(path)).unwrap()
    }

    #[test]
    fn explorer_rejects_project_root_and_escape_paths() {
        let f = Fixture::new();
        for path in ["", ".", "..", "../outside", ".git/config", ".Git/HEAD", "/tmp/outside", "foo/../../etc/passwd", "notes\0.md"] {
            for action in ["new-file", "new-folder", "rename", "delete"] {
                assert!(manage_entry(&f.0, action, path, Some("renamed")).is_err(), "{action}: {path}");
            }
            assert!(write_file(&f.0, path, "x", "").is_err(), "{path}");
            assert!(openable_file(&f.0, path).is_err(), "{path}");
        }
        assert!(manage_entry(&f.0, "rename", "a", Some(".git")).is_err());
        assert!(manage_entry(&f.0, "rename", "a", Some("..")).is_err());
        #[cfg(unix)]
        {
            fs::create_dir(f.0.join("real")).unwrap();
            std::os::unix::fs::symlink(f.0.join("real"), f.0.join("link")).unwrap();
            assert!(manage_entry(&f.0, "new-file", "link/file", None).is_err());
            // Removing the link unlinks that entry and leaves the directory it pointed at.
            manage_entry(&f.0, "delete", "link", None).unwrap();
            assert!(f.0.join("real").exists());
            assert!(!f.0.join("link").exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn explorer_does_not_follow_symlinks_out_of_the_project() {
        let f = Fixture::new();
        let root = &f.0;
        let outside = std::env::temp_dir().join(format!("pandacode-explorer-outside-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.txt"), b"secret").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("escape.txt")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape-dir")).unwrap();
        assert!(write_file(root, "escape.txt", "pwned", "secret").is_err());
        assert_eq!(fs::read(outside.join("secret.txt")).unwrap(), b"secret");
        assert!(manage_entry(root, "new-file", "escape-dir/pwned.txt", None).is_err());
        assert!(!outside.join("pwned.txt").exists());
        assert!(openable_file(root, "escape.txt").is_err());
        manage_entry(root, "delete", "escape.txt", None).unwrap();
        assert_eq!(fs::read(outside.join("secret.txt")).unwrap(), b"secret");
        assert!(!root.join("escape.txt").exists());
        manage_entry(root, "new-folder", "box", None).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("box/link")).unwrap();
        manage_entry(root, "delete", "box", None).unwrap();
        assert_eq!(fs::read(outside.join("secret.txt")).unwrap(), b"secret");
        assert!(!root.join("box").exists());
        let _ = fs::remove_dir_all(&outside);
    }
}
