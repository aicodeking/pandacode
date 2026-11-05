use super::{read_file, scoped_path, FILE_LIMIT};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

static EDITS: Mutex<()> = Mutex::new(());

fn rename_entry(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let from =
            std::ffi::CString::new(from.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        let to = std::ffi::CString::new(to.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                from.as_ptr(),
                libc::AT_FDCWD,
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            windows::Win32::Storage::FileSystem::MoveFileW(
                windows::core::PCWSTR(from.as_ptr()),
                windows::core::PCWSTR(to.as_ptr()),
            )
        }
        .map_err(|e| e.to_string())
    }
}

fn editable_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    if path.is_empty()
        || Path::new(path)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Choose a file or folder inside the project.".into());
    }
    let target = scoped_path(root, path)?;
    let mut ancestor = target.as_path();
    while ancestor != root {
        if fs::symlink_metadata(ancestor).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err("Symbolic links cannot be changed in the explorer.".into());
        }
        ancestor = ancestor.parent().ok_or("Invalid project path")?;
    }
    Ok(target)
}

pub fn manage_entry(
    root: &Path,
    action: &str,
    path: &str,
    name: Option<&str>,
) -> Result<String, String> {
    if action == "path" {
        let target = if path.is_empty() {
            root.to_path_buf()
        } else {
            scoped_path(root, path)?
        };
        return Ok(target.to_string_lossy().into_owned());
    }
    let _guard = EDITS.lock().map_err(|e| e.to_string())?;
    let target = editable_path(root, path)?;
    match action {
        "new-file" => {
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(|e| e.to_string())?;
        }
        "new-folder" => fs::create_dir(&target).map_err(|e| e.to_string())?,
        "rename" => {
            let name = name.ok_or("Enter a name.")?;
            if name.is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
                return Err("Enter a single file or folder name.".into());
            }
            let parent = Path::new(path).parent().unwrap_or(Path::new(""));
            let renamed = parent.join(name);
            let destination = editable_path(root, renamed.to_str().ok_or("Invalid filename")?)?;
            if target == destination {
                return Ok(path.into());
            }
            if fs::symlink_metadata(&destination).is_ok() {
                return Err("A file or folder with that name already exists.".into());
            }
            rename_entry(&target, &destination)?;
            return Ok(renamed.to_string_lossy().replace('\\', "/"));
        }
        "delete" => {
            if fs::symlink_metadata(&target)
                .map_err(|e| e.to_string())?
                .is_dir()
            {
                fs::remove_dir_all(target).map_err(|e| e.to_string())?;
            } else {
                fs::remove_file(target).map_err(|e| e.to_string())?;
            }
        }
        _ => return Err("Unknown file operation.".into()),
    }
    Ok(path.into())
}

pub fn file_stamp(root: &Path, path: &str) -> Result<String, String> {
    let meta = fs::metadata(scoped_path(root, path)?).map_err(|e| e.to_string())?;
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
    let target = editable_path(root, path)?;
    if read_file(root, path.into())? != expected {
        return Err("File changed on disk. Copy your edits, then reload before saving.".into());
    }
    let temporary = target.with_file_name(format!(".pandacode-save-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.set_permissions(
            fs::metadata(&target)
                .map_err(|e| e.to_string())?
                .permissions(),
        )
        .map_err(|e| e.to_string())?;
        file.write_all(content.as_bytes())
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        if read_file(root, path.into())? != expected {
            return Err("File changed on disk. Copy your edits, then reload before saving.".into());
        }
        fs::rename(&temporary, &target).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("pandacode-explorer-{}", uuid::Uuid::new_v4()));
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
        assert_eq!(
            manage_entry(root, "rename", "assets", Some("media")).unwrap(),
            "media"
        );
        assert_eq!(
            fs::read(root.join("media/image.png")).unwrap(),
            [0, 137, 80]
        );
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
        assert!(write_file(root, "notes.md", "lost", "")
            .unwrap_err()
            .contains("changed on disk"));
        assert_eq!(read_file(root, "notes.md".into()).unwrap(), "# Hello 🐼\n");
        assert!(write_file(
            root,
            "notes.md",
            &"x".repeat(FILE_LIMIT + 1),
            "# Hello 🐼\n"
        )
        .is_err());
        assert!(write_file(root, "notes.md", "\0", "# Hello 🐼\n").is_err());
    }
    #[test]
    fn explorer_rejects_project_root_and_escape_paths() {
        let f = Fixture::new();
        for path in ["", ".", "..", "../outside", ".git/config", "/tmp/outside"] {
            for action in ["new-file", "new-folder", "rename", "delete"] {
                assert!(
                    manage_entry(&f.0, action, path, Some("renamed")).is_err(),
                    "{action}: {path}"
                );
            }
        }
        #[cfg(unix)]
        {
            fs::create_dir(f.0.join("real")).unwrap();
            std::os::unix::fs::symlink(f.0.join("real"), f.0.join("link")).unwrap();
            assert!(manage_entry(&f.0, "new-file", "link/file", None).is_err());
            assert!(manage_entry(&f.0, "delete", "link", None).is_err());
        }
    }
}
