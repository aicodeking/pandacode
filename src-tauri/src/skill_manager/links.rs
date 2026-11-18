//! Links in skill roots, on every platform. Unix links are file entries. On Windows a
//! directory symlink or junction is a directory entry: it is removed with `remove_dir`, and
//! restoring one tries a directory symlink (needs Developer Mode or the privilege), then a
//! junction, then a copy of its target. A link is never silently skipped: whatever cannot be
//! put back is an error, so the record that remembers it is kept.
//!
//! The decisions (`unlink_kind`, `plan`, `attempt`) take the platform as an argument, so their
//! Windows branches are unit-tested on every platform.
use std::{
    fs, io,
    path::{Path, PathBuf},
};

/// How a link entry is removed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Unlink {
    File,
    Dir,
}

/// Windows directory symlinks and junctions need `remove_dir`; every other link (all Unix
/// links, Windows file symlinks) is removed as a file. Neither touches the target.
pub(super) fn unlink_kind(windows: bool, directory_link: bool) -> Unlink {
    if windows && directory_link {
        Unlink::Dir
    } else {
        Unlink::File
    }
}

/// What a link pointed at, when it is recreated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Target {
    Dir,
    File,
    Missing,
}

/// Why a link is recreated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Purpose {
    /// Putting back a skill-root link that quarantine or Uninstall removed.
    Restore,
    /// Copying a folder that contains the link to another volume. Never a junction (it would
    /// point at the source being moved away) or a copy (the target may be outside the folder).
    Copy,
}

/// One way to recreate a link.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Make {
    Symlink,
    SymlinkDir,
    SymlinkFile,
    Junction,
    CopyDir,
    CopyFile,
}

/// The ways to try, in order.
pub(super) fn plan(windows: bool, target: Target, purpose: Purpose) -> &'static [Make] {
    if !windows {
        return &[Make::Symlink];
    }
    match (target, purpose) {
        (Target::Dir, Purpose::Restore) => &[Make::SymlinkDir, Make::Junction, Make::CopyDir],
        (Target::File, Purpose::Restore) => &[Make::SymlinkFile, Make::CopyFile],
        (Target::File, Purpose::Copy) => &[Make::SymlinkFile],
        // Skill links lead to folders; a dangling one is put back as a directory link.
        (Target::Dir | Target::Missing, _) => &[Make::SymlinkDir],
    }
}

/// Tries `steps` in order until one succeeds. Something occupying the path stops at once
/// (`AlreadyExists`): nothing is worked around or replaced. All failing is an error.
pub(super) fn attempt(
    steps: &[Make],
    mut make: impl FnMut(Make) -> io::Result<()>,
) -> io::Result<()> {
    let mut last = io::Error::other("No way to recreate this link");
    for &step in steps {
        match make(step) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Err(error),
            Err(error) => last = error,
        }
    }
    Err(last)
}

#[cfg(windows)]
fn directory_link(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::FileTypeExt;
    meta.file_type().is_symlink_dir()
}
#[cfg(not(windows))]
fn directory_link(_: &fs::Metadata) -> bool {
    false
}

/// Unlinks the link at `path` (never its target).
pub(super) fn remove_link(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.file_type().is_symlink() {
        return Err(io::Error::other("Not a link"));
    }
    match unlink_kind(cfg!(windows), directory_link(&meta)) {
        Unlink::Dir => fs::remove_dir(path),
        Unlink::File => fs::remove_file(path),
    }
}

/// Removes whatever is at `path`: a link is unlinked (never followed), a folder deleted.
pub(super) fn remove_any(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        remove_link(path)
    } else if meta.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn target_kind(resolved: &Path) -> Target {
    match fs::metadata(resolved) {
        Ok(meta) if meta.is_dir() => Target::Dir,
        Ok(_) => Target::File,
        Err(_) => Target::Missing,
    }
}

/// Puts back at `at` a link to `link` (as read from it, possibly relative to `at`'s folder).
/// Fails with `AlreadyExists`, without replacing it, when something is at `at`.
pub(super) fn recreate(link: &Path, at: &Path) -> io::Result<()> {
    let resolved = resolve(link, at);
    let steps = plan(cfg!(windows), target_kind(&resolved), Purpose::Restore);
    attempt(steps, |step| make(step, link, &resolved, at))
}

/// Copies the link `from` as a link at `to` (folder copies across volumes).
pub(super) fn copy_link(from: &Path, to: &Path) -> io::Result<()> {
    let link = fs::read_link(from)?;
    let resolved = resolve(&link, from);
    let steps = plan(cfg!(windows), target_kind(&resolved), Purpose::Copy);
    attempt(steps, |step| make(step, &link, &resolved, to))
}

fn resolve(link: &Path, at: &Path) -> PathBuf {
    at.parent()
        .map_or_else(|| link.to_path_buf(), |parent| parent.join(link))
}

fn make(step: Make, link: &Path, resolved: &Path, at: &Path) -> io::Result<()> {
    match step {
        Make::Symlink => symlink(link, at),
        Make::SymlinkDir => symlink_dir(link, at),
        Make::SymlinkFile => symlink_file(link, at),
        Make::Junction => junction(resolved, at),
        Make::CopyDir => copy_dir(resolved, at),
        Make::CopyFile => copy_file(resolved, at),
    }
}

fn unsupported() -> io::Error {
    io::Error::new(io::ErrorKind::Unsupported, "Not available on this platform")
}

#[cfg(unix)]
fn symlink(link: &Path, at: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(link, at)
}
#[cfg(not(unix))]
fn symlink(_: &Path, _: &Path) -> io::Result<()> {
    Err(unsupported())
}

#[cfg(windows)]
fn symlink_dir(link: &Path, at: &Path) -> io::Result<()> {
    std::os::windows::fs::symlink_dir(link, at)
}
#[cfg(windows)]
fn symlink_file(link: &Path, at: &Path) -> io::Result<()> {
    std::os::windows::fs::symlink_file(link, at)
}
#[cfg(not(windows))]
fn symlink_dir(_: &Path, _: &Path) -> io::Result<()> {
    Err(unsupported())
}
#[cfg(not(windows))]
fn symlink_file(_: &Path, _: &Path) -> io::Result<()> {
    Err(unsupported())
}

/// Characters `cmd.exe` would expand or end a quoted argument on.
#[cfg_attr(not(windows), allow(dead_code))]
fn unsafe_for_cmd(text: &str) -> bool {
    text.chars()
        .any(|c| matches!(c, '"' | '%' | '!') || c.is_control())
}

/// A junction (no privilege needed) made by `mklink /J`; only plain absolute local paths.
#[cfg(windows)]
fn junction(target: &Path, at: &Path) -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    let refused = || io::Error::new(io::ErrorKind::InvalidInput, "Can't make a junction here");
    let (Some(target_text), Some(at_text)) = (target.to_str(), at.to_str()) else {
        return Err(refused());
    };
    // `read_link` may return a verbatim path; mklink wants the plain form.
    let target_text = target_text.strip_prefix(r"\\?\").unwrap_or(target_text);
    if !target.is_absolute()
        || target_text.starts_with(r"\\")
        || unsafe_for_cmd(target_text)
        || unsafe_for_cmd(at_text)
    {
        return Err(refused());
    }
    let mut command = std::process::Command::new("cmd.exe");
    command
        .raw_arg(format!(
            "/D /V:OFF /C mklink /J \"{at_text}\" \"{target_text}\""
        ))
        .creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let output =
        crate::workspace::run_process(command, "mklink", 4096, std::time::Duration::from_secs(10))
            .map_err(io::Error::other)?;
    if output.status.success() && fs::symlink_metadata(at).is_ok_and(|m| m.file_type().is_symlink())
    {
        Ok(())
    } else {
        Err(io::Error::other("Could not make a junction"))
    }
}
#[cfg(not(windows))]
fn junction(_: &Path, _: &Path) -> io::Result<()> {
    Err(unsupported())
}

/// Copies the target folder beside `at`, then moves it in without replacing anything.
fn copy_dir(target: &Path, at: &Path) -> io::Result<()> {
    let temp = at.with_file_name(format!(
        ".{}.pandacode-restore-{}",
        at.file_name().unwrap_or_default().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let result = super::quarantine::copy_tree(target, &temp, 0)
        .and_then(|()| super::quarantine::rename_exclusive(&temp, at));
    if result.is_err() {
        let _ = fs::remove_dir_all(&temp);
    }
    result
}

/// Copies the target file to `at`, which must not exist yet.
fn copy_file(target: &Path, at: &Path) -> io::Result<()> {
    let mut source = fs::File::open(target)?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(at)?;
    if let Err(error) = io::copy(&mut source, &mut file) {
        drop(file);
        let _ = fs::remove_file(at);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
#[path = "links_tests.rs"]
mod tests;
