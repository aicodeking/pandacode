//! Owner-only files for crash data (0600 files, 0700 dirs on Unix, like `secret_store.rs`):
//! reports and notices can carry panic text from user content.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[cfg(unix)]
const FILE_MODE: u32 = 0o600;
#[cfg(unix)]
const DIR_MODE: u32 = 0o700;

/// Owner-only and never through a symlink at the last path part (`O_NOFOLLOW`): a link
/// planted in the data dir must not redirect a crash report or notice elsewhere. `O_NONBLOCK`
/// so a FIFO planted at the path cannot block the open (a report is written from the panic
/// hook and by the guard before it relaunches); `write_to` then refuses anything but a file.
#[cfg(unix)]
fn private_options() -> OpenOptions {
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = OpenOptions::new();
    options.mode(FILE_MODE).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    options
}

/// Windows: the link itself (`FILE_FLAG_OPEN_REPARSE_POINT`), as `read_options`; the
/// regular-file check (`regular_blocking`) then refuses it.
#[cfg(windows)]
fn private_options() -> OpenOptions {
    use std::os::windows::fs::OpenOptionsExt;
    let mut options = OpenOptions::new();
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    options
}

#[cfg(not(any(unix, windows)))]
fn private_options() -> OpenOptions {
    OpenOptions::new()
}

#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

/// Reading never through a symlink either: `O_NOFOLLOW` (and `O_NONBLOCK`, so a FIFO planted
/// there cannot block the open) on Unix, the link itself (`FILE_FLAG_OPEN_REPARSE_POINT`) on
/// Windows; the regular-file check in `read_private` then refuses it.
#[cfg(unix)]
fn read_options() -> OpenOptions {
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = OpenOptions::new();
    options.read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    options
}

#[cfg(windows)]
fn read_options() -> OpenOptions {
    use std::os::windows::fs::OpenOptionsExt;
    let mut options = OpenOptions::new();
    options.read(true).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    options
}

#[cfg(not(any(unix, windows)))]
fn read_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true);
    options
}

/// The bytes of a regular file of at most `max` bytes at `path` (not through a symlink);
/// None for anything else or an error.
pub fn read_private(path: &Path, max: u64) -> Option<Vec<u8>> {
    let file = read_options().open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > max {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(max + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= max).then_some(bytes)
}

/// At most the first `max` bytes of the regular file at `path` (not through a symlink, never
/// blocking on a FIFO); None for anything else or an error. For headers of longer files.
pub fn read_prefix(path: &Path, max: u64) -> Option<Vec<u8>> {
    let file = read_options().open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(max).read_to_end(&mut bytes).ok()?;
    Some(bytes)
}

/// A file that existed with wider permissions keeps them through `open`: narrow it.
fn narrow(file: &File) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(FILE_MODE))?;
    }
    #[cfg(not(unix))]
    let _ = file;
    Ok(())
}

/// `create_dir_all`, but every folder it creates (the data folder too, on a first run) is
/// owner-only on Unix. Folders that already exist keep their mode: the data folder is shared
/// with the rest of the app and may be set up that way on purpose.
pub fn create_dirs(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().recursive(true).mode(DIR_MODE).create(dir)
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(dir)
}

/// Creates `dir` (and parents) and makes `dir` itself owner-only. On Unix the mode is set
/// through a handle opened with `O_NOFOLLOW | O_DIRECTORY`, so a symlink at `dir` fails
/// instead of having its target's permissions changed.
pub fn private_dir(dir: &Path) -> std::io::Result<()> {
    create_dirs(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        if std::fs::symlink_metadata(dir)?.file_type().is_symlink() {
            // The folder's name only: this error reaches the guard's log, never a home path.
            let name = dir.file_name().unwrap_or_default().to_string_lossy();
            return Err(std::io::Error::other(format!("{name} is a symlink")));
        }
        let handle = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY).open(dir)?;
        handle.set_permissions(std::fs::Permissions::from_mode(DIR_MODE))?;
    }
    Ok(())
}

/// Linux: the webview's data folder (Tauri points WebKitGTK at `app_local_data_dir`), whose
/// local storage holds unsent drafts as plain text, made owner-only like the crash files.
/// Never fails startup: an error (a symlink there is refused) is logged once, by name only.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn narrow_webview_data(dir: &Path) {
    if let Err(error) = private_dir(dir) {
        eprintln!("Could not make the webview data folder private: {error}");
    }
}

/// A new owner-only file; `AlreadyExists` when anything (a file, a link, a FIFO) is there.
pub fn create_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    write_to(private_options().write(true).create_new(true).open(path)?, bytes)
}

fn write_to(file: File, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = regular_blocking(file)?;
    narrow(&file)?;
    file.write_all(bytes)
}

/// Temp file + rename, so a reader never sees half a file.
pub fn write_private_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        create_dirs(dir)?;
    }
    let temp = temp_path(path);
    // A stale temp file (or a planted link: removing it removes the link) from an earlier
    // process with this pid; then `create_new` (O_EXCL) refuses anything that reappears.
    let _ = std::fs::remove_file(&temp);
    write_to(private_options().write(true).create_new(true).open(&temp)?, bytes)?;
    std::fs::rename(&temp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}

fn temp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(format!(".{}.tmp", std::process::id()));
    path.with_file_name(name)
}

/// An exclusive advisory lock on `<path>.lock` (`flock` on Unix, `LockFileEx` on Windows,
/// through `File::try_lock`), held until the returned file is dropped (or the process ends).
/// The lock file stays empty, owner-only and is never opened through a symlink; it is never
/// removed (removing a lock file lets two holders race). Waits at most `wait` for another
/// holder, then fails.
pub fn lock_exclusive(path: &Path, wait: std::time::Duration) -> std::io::Result<File> {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".lock");
    let file = regular_blocking(private_options().write(true).create(true).open(path.with_file_name(name))?)?;
    narrow(&file)?;
    let deadline = std::time::Instant::now() + wait;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::Error(error)) => return Err(error),
            Err(std::fs::TryLockError::WouldBlock) if std::time::Instant::now() >= deadline => {
                return Err(std::io::Error::other("another PandaCode process is changing the crash state"));
            }
            Err(std::fs::TryLockError::WouldBlock) => std::thread::sleep(std::time::Duration::from_millis(10)),
        }
    }
}

/// Size cap of each log (`serve-restart.log`, `crash-guard.log`): a larger one moves to
/// `<name>.1` (one old file kept).
pub const LOG_MAX_BYTES: u64 = 1024 * 1024;

/// Appending, owner-only, never through a symlink, and (Unix) `O_NONBLOCK` so a FIFO planted
/// at the path cannot block the open; `regular_blocking` then refuses anything but a file.
#[cfg(unix)]
fn log_options() -> OpenOptions {
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = OpenOptions::new();
    options.mode(FILE_MODE).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).create(true).append(true);
    options
}

#[cfg(windows)]
fn log_options() -> OpenOptions {
    use std::os::windows::fs::OpenOptionsExt;
    let mut options = OpenOptions::new();
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).create(true).append(true);
    options
}

#[cfg(not(any(unix, windows)))]
fn log_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    options
}

/// `file` if it is a regular file, with `O_NONBLOCK` cleared again on Unix.
fn regular_blocking(file: File) -> std::io::Result<File> {
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::other("not a regular file"));
    }
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let fd = file.as_raw_fd();
        // SAFETY: fcntl(2) on a descriptor `file` owns; only its status flags change.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        // SAFETY: as above.
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(file)
}

/// An append-only log capped at `max` bytes: a larger one moves to `<name>.1` first.
pub fn open_private_log(path: &Path, max: u64) -> std::io::Result<File> {
    // `symlink_metadata`: a link is never followed (and `rename` moves the link itself).
    if std::fs::symlink_metadata(path).is_ok_and(|meta| meta.len() > max) {
        let mut old = path.as_os_str().to_os_string();
        old.push(".1");
        std::fs::rename(path, PathBuf::from(old))?;
    }
    let file = regular_blocking(log_options().open(path)?)?;
    narrow(&file)?;
    Ok(file)
}

/// Whether `target` is the file at `path` now (not through a symlink).
#[cfg(unix)]
pub fn writes_to(target: std::os::fd::BorrowedFd<'_>, path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(current) = target.try_clone_to_owned().map(File::from).and_then(|file| file.metadata()) else { return false };
    std::fs::symlink_metadata(path).is_ok_and(|at_path| (current.dev(), current.ino()) == (at_path.dev(), at_path.ino()))
}

/// A process whose output was redirected to the log at `path` keeps writing through that
/// handle (callers check at start that the first of `targets` was that log): once it has grown
/// past `max`, the log is rotated (`open_private_log`); once it was deleted (another process's
/// prune), the log is opened again. Either way every target is pointed at the fresh file
/// (`dup2`). True when it did either.
#[cfg(unix)]
pub fn rotate_redirected_log(path: &Path, max: u64, targets: &[std::os::fd::BorrowedFd<'_>]) -> std::io::Result<bool> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;
    let Some(first) = targets.first() else { return Ok(false) };
    let current = File::from(first.try_clone_to_owned()?).metadata()?;
    let deleted = current.nlink() == 0;
    if !deleted && (!writes_to(*first, path) || current.len() <= max) {
        return Ok(false);
    }
    let fresh = open_private_log(path, max)?;
    for target in targets {
        // SAFETY: dup2(2) onto a descriptor the caller keeps open; it only changes which file
        // that number refers to, atomically for writers on other threads.
        if unsafe { libc::dup2(fresh.as_raw_fd(), target.as_raw_fd()) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(true)
}

/// A log this process writes through has its modification time kept within this of now
/// (`refresh_output`), far inside the 90-day prune age.
pub const LOG_FRESH_WITHIN: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// Sets the modification time of the file behind `target` (this process's own output, a log)
/// to `now` when it is more than `LOG_FRESH_WITHIN` away from it, so another process's prune
/// (`prune_logs`, which only sees the time) never takes a log still in use for an unwritten
/// one. Through the handle (`futimens`), never by path, so never through a symlink. True when
/// it set the time.
#[cfg(unix)]
pub fn refresh_output(target: std::os::fd::BorrowedFd<'_>, now: std::time::SystemTime) -> std::io::Result<bool> {
    let file = File::from(target.try_clone_to_owned()?);
    let modified = file.metadata()?.modified()?;
    let off = now.duration_since(modified).unwrap_or_else(|ahead| ahead.duration());
    if off <= LOG_FRESH_WITHIN {
        return Ok(false);
    }
    file.set_modified(now).map(|()| true)
}

/// Whether this process's stdout or stderr is the file `meta` describes.
#[cfg(unix)]
fn own_output(meta: &std::fs::Metadata) -> bool {
    use std::os::fd::AsFd;
    use std::os::unix::fs::MetadataExt;
    let same = |fd: std::os::fd::BorrowedFd<'_>| {
        fd.try_clone_to_owned().map(File::from).and_then(|file| file.metadata()).is_ok_and(|out| (out.dev(), out.ino()) == (meta.dev(), meta.ino()))
    };
    same(std::io::stdout().as_fd()) || same(std::io::stderr().as_fd())
}

#[cfg(not(unix))]
fn own_output(_meta: &std::fs::Metadata) -> bool {
    false
}

/// Removes each log in `names` (and its `.1`) when last written more than `max_age` before
/// `now`, or more than `report::FUTURE_SLACK_MS` after it (such a time would never age out):
/// the same rules as crash reports. Never a log this process writes to (its stdout or stderr):
/// a quiet relaunched `serve` would go on writing into a deleted file.
pub fn prune_logs(dir: &Path, names: &[&str], now: std::time::SystemTime, max_age: std::time::Duration) {
    for name in names.iter().flat_map(|name| [name.to_string(), format!("{name}.1")]) {
        let path = dir.join(&name);
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if expired(&meta, now, max_age) && !own_output(&meta) {
            if let Err(error) = std::fs::remove_file(&path) {
                eprintln!("Could not remove the old {name}: {error}");
            }
        }
    }
}

/// Last changed more than `max_age` before `now`, or more than `report::FUTURE_SLACK_MS` after
/// it (such a time would never age out).
fn expired(meta: &std::fs::Metadata, now: std::time::SystemTime, max_age: std::time::Duration) -> bool {
    let future_slack = std::time::Duration::from_millis(super::report::FUTURE_SLACK_MS);
    meta.modified().is_ok_and(|modified| match now.duration_since(modified) {
        Ok(age) => age > max_age,
        Err(ahead) => ahead.duration() > future_slack,
    })
}

/// Removes temp files a guard or app that died mid-save left beside `names`
/// (`<name>.<pid>.tmp`, as `temp_path` builds them) once last changed more than `min_age`
/// before `now` (or dated more than `report::FUTURE_SLACK_MS` ahead of it): a younger one may
/// belong to a save in progress in another process. Only
/// those exact names, and the entry itself: a symlink planted there is removed, not followed.
pub fn prune_temp_files(dir: &Path, names: &[&str], now: std::time::SystemTime, min_age: std::time::Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.filter_map(Result::ok) {
        if !entry.file_name().to_str().is_some_and(|name| names.iter().any(|base| is_temp_name(name, base))) {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if meta.is_dir() || !expired(&meta, now, min_age) {
            continue;
        }
        if let Err(error) = std::fs::remove_file(&path) {
            eprintln!("Could not remove the stale {}: {error}", entry.file_name().to_string_lossy());
        }
    }
}

/// Whether `name` is `<base>.<pid>.tmp` with a decimal pid.
fn is_temp_name(name: &str, base: &str) -> bool {
    let pid = name.strip_prefix(base).and_then(|rest| rest.strip_prefix('.')).and_then(|rest| rest.strip_suffix(".tmp"));
    pid.is_some_and(|pid| !pid.is_empty() && pid.bytes().all(|byte| byte.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("pandacode-crash-files-{}", uuid::Uuid::new_v4()))
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn files_and_dirs_are_owner_only_even_when_they_existed() {
        let dir = temp_dir();
        private_dir(&dir).unwrap();
        let file = dir.join("state.json");
        std::fs::write(&file, "old").unwrap();
        write_private_atomic(&file, b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        #[cfg(unix)]
        {
            assert_eq!(mode(&dir), 0o700);
            assert_eq!(mode(&file), 0o600);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_data_folder_the_guard_creates_is_owner_only_but_an_existing_one_keeps_its_mode() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_dir();
        // Created here (with a parent): both owner-only, whatever the umask lets through.
        let data = root.join("data");
        write_private_atomic(&data.join("crash-guard.json"), b"{}").unwrap();
        assert_eq!((mode(&root), mode(&data)), (0o700, 0o700));
        // Already there with a mode chosen elsewhere: left alone.
        let shared = root.join("shared");
        std::fs::create_dir(&shared).unwrap();
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o750)).unwrap();
        write_private_atomic(&shared.join("crash-guard.json"), b"{}").unwrap();
        create_dirs(&shared).unwrap();
        assert_eq!(mode(&shared), 0o750);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_log_rotates_past_its_cap() {
        let dir = temp_dir();
        private_dir(&dir).unwrap();
        let log = dir.join("serve.log");
        open_private_log(&log, 4).unwrap().write_all(b"0123456789").unwrap();
        open_private_log(&log, 4).unwrap().write_all(b"ab").unwrap();
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "ab");
        assert_eq!(std::fs::read_to_string(dir.join("serve.log.1")).unwrap(), "0123456789");
        #[cfg(unix)]
        assert_eq!(mode(&log), 0o600);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_redirected_log_is_rotated_in_place_past_its_cap() {
        use std::os::fd::{AsFd, AsRawFd};
        let dir = temp_dir();
        private_dir(&dir).unwrap();
        let log = dir.join("serve.log");
        let mut out = open_private_log(&log, 4).unwrap();
        // SAFETY: fcntl(2) on a descriptor `out` owns.
        assert_eq!(unsafe { libc::fcntl(out.as_raw_fd(), libc::F_GETFL) } & libc::O_NONBLOCK, 0, "left non-blocking");
        out.write_all(b"0123").unwrap();
        assert!(!rotate_redirected_log(&log, 4, &[out.as_fd()]).unwrap(), "at the cap, not past it");
        out.write_all(b"45").unwrap();
        assert!(rotate_redirected_log(&log, 4, &[out.as_fd()]).unwrap());
        out.write_all(b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(dir.join("serve.log.1")).unwrap(), "012345");
        assert_eq!(mode(&log), 0o600);
        // Output that goes elsewhere is never touched, however large.
        let mut other = std::fs::File::create(dir.join("other.log")).unwrap();
        other.write_all(&[b'x'; 64]).unwrap();
        assert!(!rotate_redirected_log(&log, 4, &[other.as_fd()]).unwrap());
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "new");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_planted_fifo_never_blocks_the_log() {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::OpenOptionsExt;
        let dir = temp_dir();
        private_dir(&dir).unwrap();
        let fifo = dir.join("serve.log");
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: mkfifo(3) with a valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        // No reader: a blocking open would wait forever.
        assert!(open_private_log(&fifo, 1 << 20).is_err());
        // With a reader the open itself succeeds, and the type check refuses it.
        let _reader = OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(&fifo).unwrap();
        assert!(open_private_log(&fifo, 1 << 20).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_planted_fifo_never_blocks_a_report_or_state_write() {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::OpenOptionsExt;
        let dir = temp_dir();
        private_dir(&dir).unwrap();
        let fifo = dir.join("1-crash.txt");
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: mkfifo(3) with a valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        // No reader: a blocking open would wait forever.
        assert!(create_private(&fifo, b"report").is_err());
        // With a reader the open succeeds, and the type check refuses it before any write.
        let mut reader = OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(&fifo).unwrap();
        assert!(create_private(&fifo, b"report").is_err());
        let mut read = Vec::new();
        let _ = reader.read_to_end(&mut read);
        assert!(read.is_empty(), "the report went into the FIFO");
        // A new regular file is written, and left blocking; an existing one is never replaced.
        let file = dir.join("2-crash.txt");
        create_private(&file, b"report").unwrap();
        assert_eq!(create_private(&file, b"again").unwrap_err().kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "report");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stale_temp_files_are_swept_and_nothing_else() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let hour = std::time::Duration::from_secs(3600);
        let now = std::time::SystemTime::now();
        let old = |name: &str| {
            let path = dir.join(name);
            std::fs::File::create(&path).unwrap().set_modified(now - 2 * hour).unwrap();
            path
        };
        let stale = [old("crash-guard.json.123.tmp"), old("crash-guard-serve.json.9.tmp")];
        let kept = [
            old("crash-guard.json"),
            old("crash-guard.json.tmp"),
            old("crash-guard.json.12a.tmp"),
            old("crash-guard.json..tmp"),
            old("crash-guard.json.123.tmp.bak"),
            old("other.json.123.tmp"),
            old("xcrash-guard.json.123.tmp"),
        ];
        // A save in progress in another process.
        let young = dir.join("crash-guard.json.456.tmp");
        std::fs::write(&young, "half").unwrap();
        std::fs::create_dir(dir.join("crash-guard.json.7.tmp")).unwrap();
        #[cfg(unix)]
        let victim = {
            let victim = old("victim.txt");
            let link = dir.join("crash-guard.json.8.tmp");
            std::os::unix::fs::symlink(&victim, &link).unwrap();
            // The link's own time is new: only a stale link goes, and never its target.
            prune_temp_files(&dir, &["crash-guard.json"], now + 2 * hour, hour);
            assert!(std::fs::symlink_metadata(&link).is_err() && victim.exists());
            std::fs::write(&young, "half").unwrap();
            victim
        };
        prune_temp_files(&dir, &["crash-guard.json", "crash-guard-serve.json"], now, hour);
        assert!(stale.iter().all(|path| !path.exists()));
        assert!(kept.iter().all(|path| path.exists()) && young.exists() && dir.join("crash-guard.json.7.tmp").is_dir());
        #[cfg(unix)]
        assert!(victim.exists());
        // A missing directory is fine.
        prune_temp_files(&dir.join("none"), &["crash-guard.json"], now, hour);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_temp_file_dated_far_in_the_future_is_swept_too() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let hour = std::time::Duration::from_secs(3600);
        let slack = std::time::Duration::from_millis(super::super::report::FUTURE_SLACK_MS);
        let now = std::time::SystemTime::now();
        let dated = |name: &str, at| {
            let path = dir.join(name);
            std::fs::File::create(&path).unwrap().set_modified(at).unwrap();
            path
        };
        // Written under a clock set far ahead: it would never age out.
        let future = dated("crash-guard.json.1.tmp", now + slack + hour);
        // A little ahead (clock skew) may still be a save in progress.
        let skewed = dated("crash-guard.json.2.tmp", now + hour);
        prune_temp_files(&dir, &["crash-guard.json"], now, hour);
        assert!(!future.exists() && skewed.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn old_logs_are_removed() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let day = std::time::Duration::from_secs(86_400);
        let now = std::time::SystemTime::now();
        let (current, old, other) = (dir.join("a.log"), dir.join("a.log.1"), dir.join("b.log"));
        std::fs::write(&current, "new").unwrap();
        std::fs::write(&other, "new").unwrap();
        std::fs::File::create(&old).unwrap().set_modified(now - 91 * day).unwrap();
        prune_logs(&dir, &["a.log", "b.log"], now, 90 * day);
        assert!(current.exists() && other.exists() && !old.exists());
        prune_logs(&dir, &["a.log", "b.log"], now + 91 * day, 90 * day);
        assert!(!current.exists() && !other.exists());
        // Dated more than a day ahead: removed; less: kept.
        let (ahead, near) = (dir.join("a.log"), dir.join("b.log"));
        std::fs::File::create(&ahead).unwrap().set_modified(now + 2 * day).unwrap();
        std::fs::File::create(&near).unwrap().set_modified(now + day / 2).unwrap();
        prune_logs(&dir, &["a.log", "b.log"], now, 90 * day);
        assert!(!ahead.exists() && near.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A log this process writes through (its stderr) is never pruned, however old; once
    /// another process's prune deleted it, the size check opens it again and points the
    /// handle there.
    #[cfg(unix)]
    #[test]
    fn a_log_in_use_is_kept_and_a_deleted_one_is_reopened() {
        use std::os::fd::{AsFd, AsRawFd};
        let dir = temp_dir();
        private_dir(&dir).unwrap();
        let log = dir.join("serve.log");
        let day = std::time::Duration::from_secs(86_400);
        let now = std::time::SystemTime::now();
        let mut out = open_private_log(&log, 1 << 20).unwrap();
        out.write_all(b"old").unwrap();
        out.set_modified(now - 91 * day).unwrap();
        // Point this process's stderr at the log for the prune, then put it back.
        // SAFETY: dup/dup2(2) on descriptors this test owns or this process's stderr.
        let saved = unsafe { libc::dup(libc::STDERR_FILENO) };
        assert!(saved >= 0);
        // SAFETY: as above.
        assert!(unsafe { libc::dup2(out.as_raw_fd(), libc::STDERR_FILENO) } >= 0);
        prune_logs(&dir, &["serve.log"], now, 90 * day);
        // SAFETY: as above.
        unsafe {
            libc::dup2(saved, libc::STDERR_FILENO);
            libc::close(saved);
        }
        assert!(log.exists(), "pruned the log this process writes to");
        // Another process's prune deletes it: the check opens it again.
        std::fs::remove_file(&log).unwrap();
        assert!(rotate_redirected_log(&log, 1 << 20, &[out.as_fd()]).unwrap());
        out.write_all(b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "new");
        assert_eq!(mode(&log), 0o600);
        assert!(!rotate_redirected_log(&log, 1 << 20, &[out.as_fd()]).unwrap(), "nothing to do now");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// The process writing a quiet log keeps its time fresh, so a prune in any other process
    /// (the plain time rule: this test's own output is not the log) keeps it.
    #[cfg(unix)]
    #[test]
    fn a_log_in_use_keeps_a_fresh_time_and_survives_another_prune() {
        use std::os::fd::AsFd;
        let dir = temp_dir();
        private_dir(&dir).unwrap();
        let log = dir.join("serve.log");
        let day = std::time::Duration::from_secs(86_400);
        let now = std::time::SystemTime::now();
        let out = open_private_log(&log, 1 << 20).unwrap();
        out.set_modified(now - 91 * day).unwrap();
        assert!(refresh_output(out.as_fd(), now).unwrap());
        assert!(!refresh_output(out.as_fd(), now + day / 2).unwrap(), "at most once a day");
        prune_logs(&dir, &["serve.log"], now, 90 * day);
        assert!(log.exists(), "pruned a log still in use");
        // A time more than a day ahead is set back too, or the future rule would prune it.
        out.set_modified(now + 2 * day).unwrap();
        assert!(refresh_output(out.as_fd(), now).unwrap());
        prune_logs(&dir, &["serve.log"], now, 90 * day);
        assert!(log.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_never_followed() {
        use std::os::unix::fs::symlink;
        let dir = temp_dir();
        private_dir(&dir).unwrap();
        let outside = temp_dir();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::set_permissions(&outside, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let victim = outside.join("victim.txt");
        std::fs::write(&victim, "keep").unwrap();
        std::fs::set_permissions(&victim, std::os::unix::fs::PermissionsExt::from_mode(0o644)).unwrap();
        let link = dir.join("report.txt");
        symlink(&victim, &link).unwrap();
        assert!(create_private(&link, b"evil").is_err());
        assert!(open_private_log(&link, 1 << 20).is_err());
        let linked_dir = dir.join("crash-reports");
        symlink(&outside, &linked_dir).unwrap();
        let refused = private_dir(&linked_dir).unwrap_err().to_string();
        // The webview data folder: a link is left alone (and its target unchanged), no panic.
        narrow_webview_data(&linked_dir);
        assert_eq!(refused, "crash-reports is a symlink", "the error names the folder only");
        // A link planted at the temp path is replaced, never written through.
        let state = dir.join("state.json");
        symlink(&victim, temp_path(&state)).unwrap();
        write_private_atomic(&state, b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&state).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
        assert_eq!((mode(&victim), mode(&outside)), (0o644, 0o755));
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_webview_data_folder_is_narrowed_to_its_owner() {
        let dir = temp_dir();
        let webview = dir.join("ai.pandacode.desktop");
        std::fs::create_dir_all(webview.join("localstorage")).unwrap();
        std::fs::set_permissions(&webview, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        narrow_webview_data(&webview);
        assert_eq!(mode(&webview), 0o700);
        // A missing folder is made private.
        narrow_webview_data(&dir.join("new"));
        assert_eq!(mode(&dir.join("new")), 0o700);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
