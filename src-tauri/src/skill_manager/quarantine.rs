//! Flagged installs are moved out of every agent's reach into `skill-quarantine/` in app data.
//! Only folders and links that the flagged install itself created are moved; the record keeps
//! their original paths so `skill_manager_restore` ("Turn on anyway") can put them back.
use super::*;
#[path = "set_aside.rs"]
pub(super) mod set_aside;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredAgent {
    pub(super) harness: String,
    pub(super) scope: String,
    pub(super) path: String,
    #[serde(default)]
    pub(super) project_id: Option<String>,
}

/// At most this many safety findings are kept per quarantined install.
pub(super) const MAX_FLAGS: usize = 20;

/// Why an install was flagged (a safety finding), kept with its quarantine record.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Flag {
    pub(super) rule: String,
    #[serde(serialize_with = "safety::serialize_warning")]
    pub(super) file: String,
    pub(super) line: usize,
    #[serde(serialize_with = "safety::serialize_warning")]
    pub(super) excerpt: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Item {
    pub(super) original: PathBuf,
    /// Folder name inside the entry's quarantine directory, for a moved folder.
    #[serde(default)]
    pub(super) stored: Option<String>,
    /// Target of a removed symbolic link, recreated on restore.
    #[serde(default)]
    pub(super) link: Option<PathBuf>,
    /// Set when a failed Restore or Undo put this item back and could not take it back again,
    /// so it stays at its original path with its stored copy gone. Only then does it count as
    /// already restored (`already_restored`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(super) put_back: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Entry {
    id: String,
    name: String,
    names: BTreeSet<String>,
    #[serde(default)]
    description: String,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    resolved: bool,
    #[serde(default)]
    agents: Vec<StoredAgent>,
    items: Vec<Item>,
    /// Older records: the same install also switched names off for copies it could not move,
    /// without saying which. Restore leaves those switches alone.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    switched_off: bool,
    /// Exactly the names this install added to the off list of its scope; restore clears only
    /// these, never a switch the user set before or after.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    switched: Option<BTreeSet<String>>,
    /// The project whose switches `switched` went into (a project-scoped add); none: All
    /// projects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    switched_project: Option<String>,
    #[serde(default)]
    flags: Vec<Flag>,
}

/// What an install knows about a flagged skill it is about to quarantine.
pub(super) struct Flagged {
    pub(super) name: String,
    pub(super) names: BTreeSet<String>,
    pub(super) description: String,
    pub(super) source: Option<String>,
    pub(super) resolved: bool,
    pub(super) agents: Vec<StoredAgent>,
    pub(super) flags: Vec<Flag>,
}

fn records_path(prefs: &Path) -> PathBuf {
    prefs.with_file_name("skill-quarantine.json")
}
fn store_dir(prefs: &Path) -> PathBuf {
    prefs.with_file_name("skill-quarantine")
}

pub(super) fn read(prefs: &Path) -> Result<Vec<Entry>, String> {
    let path = records_path(prefs);
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Could not read quarantined skills: {e}")),
        Ok(_) => {}
    }
    let text = read_text(&path).ok_or("Could not read quarantined skills (maximum 256 KB).")?;
    serde_json::from_str(&text).map_err(|e| format!("Could not read quarantined skills: {e}"))
}
fn write(prefs: &Path, entries: &[Entry]) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(entries).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Too many quarantined skills; restore or delete some first.".into());
    }
    prefs::write_prefs_file(&records_path(prefs), &bytes)
}

/// Moves `folders` (links first) into quarantine and records them. All or nothing: on any
/// failure the moved items are put back and nothing is recorded. Returns the record's ID.
pub(super) fn quarantine(
    prefs: &Path,
    flagged: Flagged,
    folders: &BTreeSet<PathBuf>,
    roots: &BTreeSet<PathBuf>,
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let dir = store_dir(prefs).join(&id);
    let mut ordered: Vec<_> = folders.iter().collect();
    ordered.sort_by_key(|p| !fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()));
    let mut items = Vec::new();
    let result = (|| {
        for (index, folder) in ordered.into_iter().enumerate() {
            safety::check_inside_roots(folder, roots).map_err(|e| e.to_string())?;
            let meta = fs::symlink_metadata(folder).map_err(|e| e.to_string())?;
            if meta.file_type().is_symlink() {
                let link = fs::read_link(folder).map_err(|e| e.to_string())?;
                links::remove_link(folder).map_err(|e| e.to_string())?;
                items.push(Item {
                    original: folder.clone(),
                    stored: None,
                    link: Some(link),
                    put_back: false,
                });
            } else {
                fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let stored = index.to_string();
                let to = dir.join(&stored);
                let moved = move_folder(folder, &to);
                if moved.is_ok() || kept_after_failed_move(folder, &to) {
                    items.push(Item {
                        original: folder.clone(),
                        stored: Some(stored),
                        link: None,
                        put_back: false,
                    });
                }
                moved.map_err(|e| e.to_string())?;
            }
        }
        let _guard = recover(&LOCK);
        let mut entries = read(prefs)?;
        entries.push(Entry {
            id: id.clone(),
            name: flagged.name,
            names: flagged.names,
            description: flagged.description,
            source: flagged.source,
            resolved: flagged.resolved,
            agents: flagged.agents,
            items: items.clone(),
            switched_off: false,
            switched: Some(BTreeSet::new()),
            switched_project: None,
            flags: flagged.flags.into_iter().take(MAX_FLAGS).collect(),
        });
        write(prefs, &entries)
    })();
    if let Err(error) = result {
        return Err(match put_back(&items, &dir) {
            Ok(()) => {
                let _ = fs::remove_dir_all(&dir);
                format!("Could not quarantine flagged skill files: {error}")
            }
            // What could not be put back stays in the quarantine folder, never deleted.
            Err(stuck) => format!(
                "Could not quarantine flagged skill files: {error}. {stuck}, kept in {}",
                dir.display()
            ),
        });
    }
    Ok(id)
}

/// Records the names an install added to the All projects off list for each of its quarantine
/// records. The caller holds `LOCK`, in the same critical section as the preferences save.
#[cfg(test)]
pub(super) fn record_switched(
    prefs: &Path,
    added: &BTreeMap<String, BTreeSet<String>>,
) -> Result<(), String> {
    record_switched_in(prefs, added, None)
}

/// As `record_switched`, for the off list of `project` (a project key) or All projects (`None`).
pub(super) fn record_switched_in(
    prefs: &Path,
    added: &BTreeMap<String, BTreeSet<String>>,
    project: Option<&str>,
) -> Result<(), String> {
    let mut entries = read(prefs)?;
    let mut changed = false;
    for entry in &mut entries {
        if let Some(names) = added.get(&entry.id).filter(|n| !n.is_empty()) {
            entry
                .switched
                .get_or_insert_with(BTreeSet::new)
                .extend(names.iter().cloned());
            entry.switched_project = project.map(str::to_owned);
            changed = true;
        }
    }
    if changed {
        write(prefs, &entries)?;
    }
    Ok(())
}

/// Undoes a partial move. Every item is tried; the error names those that could not be put
/// back, so the caller keeps `dir` (their only copy) instead of deleting it.
pub(super) fn put_back(items: &[Item], dir: &Path) -> Result<(), String> {
    let stuck: Vec<String> = items
        .iter()
        .rev()
        .filter_map(|item| {
            restore_item(item, dir)
                .err()
                .map(|e| format!("{} ({e})", item.original.display()))
        })
        .collect();
    if stuck.is_empty() {
        Ok(())
    } else {
        Err(format!("Could not put back {}", stuck.join(", ")))
    }
}

pub(super) fn restore_item(item: &Item, dir: &Path) -> std::io::Result<()> {
    if let Some(parent) = item.original.parent() {
        fs::create_dir_all(parent)?;
    }
    // Neither step replaces anything that appeared at the original path after the check. A
    // link that can't be recreated is an error (the record is kept), never skipped.
    match (&item.stored, &item.link) {
        (Some(stored), _) => move_folder_exclusive(&dir.join(stored), &item.original),
        (None, Some(link)) => links::recreate(link, &item.original),
        // Nothing was moved for this item.
        (None, None) => Ok(()),
    }
}

#[cfg(test)]
thread_local! {
    /// Tests: renames by `move_folder` and `rename_exclusive` on this thread fail as across
    /// volumes, so moves take the copy-then-delete path.
    pub(super) static CROSS_VOLUME: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Tests: holds `CROSS_VOLUME` on for this thread until dropped.
#[cfg(test)]
pub(super) struct CrossVolume;
#[cfg(test)]
impl CrossVolume {
    pub(super) fn on() -> Self {
        CROSS_VOLUME.set(true);
        Self
    }
}
#[cfg(test)]
impl Drop for CrossVolume {
    fn drop(&mut self) {
        CROSS_VOLUME.set(false);
    }
}

#[cfg(test)]
fn cross_volume() -> bool {
    CROSS_VOLUME.get()
}
#[cfg(not(test))]
fn cross_volume() -> bool {
    false
}

/// Whether a rename failed only because `from` and `to` are on different volumes (EXDEV on
/// Unix, ERROR_NOT_SAME_DEVICE on Windows): the one error a copy can work around.
fn crosses_devices(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::CrossesDevices {
        return true;
    }
    #[cfg(unix)]
    let code = libc::EXDEV;
    #[cfg(windows)]
    let code = 17;
    #[cfg(not(any(unix, windows)))]
    let code = -1;
    error.raw_os_error() == Some(code)
}

/// After `move_folder(from, to)` failed: whether the copy at `to` is the one full copy (the
/// original was set aside and could not be put back). The caller then records it as moved, so
/// it is put back with the rest instead of deleted with the store folder.
pub(super) fn kept_after_failed_move(from: &Path, to: &Path) -> bool {
    fs::symlink_metadata(from).is_err() && to.is_dir()
}

/// Moves the folder `from` to `to`. Either it fully moved (Ok) or `from` is untouched and
/// nothing is left at `to` (Err), except when a move across volumes can't be undone: then
/// `from` is gone and `to` is the one full copy (`kept_after_failed_move`). Only a cross-device rename falls back to a copy: any other
/// rename error (access denied, a locked handle) is returned as is.
pub(super) fn move_folder(from: &Path, to: &Path) -> std::io::Result<()> {
    if !cross_volume() {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) if !crosses_devices(&error) => return Err(error),
            Err(_) => {}
        }
    }
    // Another volume: copy (a partial copy is discarded), then set the original aside within
    // its own folder, so its name is free in one step, and only then delete it.
    if let Err(error) = copy_tree(from, to, 0) {
        let _ = fs::remove_dir_all(to);
        return Err(error);
    }
    let aside = set_aside::path(from);
    if let Err(error) = fs::rename(from, &aside) {
        if let Err(cleanup) = fs::remove_dir_all(to) {
            eprintln!("Warning: could not remove {}: {cleanup}", to.display());
        }
        return Err(std::io::Error::new(
            error.kind(),
            format!("could not move {}: {error}", from.display()),
        ));
    }
    // The original name is free and `to` is the one full copy. The hidden set-aside folder
    // loses its SKILL.md first (or the move is undone); other remains are only reported.
    set_aside::discard(&aside, from, to)
}

/// Like `move_folder`, but fails with `AlreadyExists` instead of replacing anything at `to`.
/// `from` is a stored copy (in a quarantine or uninstall folder): across volumes it is never
/// removed in place, so a failure leaves it either whole or gone, never partial.
fn move_folder_exclusive(from: &Path, to: &Path) -> std::io::Result<()> {
    match rename_exclusive(from, to) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(error),
        // Another volume: `copy_tree` creates `to` exclusively.
        Err(_) => {
            if let Err(error) = copy_tree(from, to, 0) {
                if error.kind() != std::io::ErrorKind::AlreadyExists {
                    let _ = fs::remove_dir_all(to);
                }
                return Err(error);
            }
            // Set the source aside (a rename within its own folder) before deleting it: the
            // record never points at a half-deleted copy, and Undo's rollback can move the item
            // back under its stored name. If it can't be set aside, the copy just made goes and
            // the stored copy stays whole, so the record can be retried.
            let aside = set_aside::path(from);
            if let Err(error) = fs::rename(from, &aside) {
                let _ = fs::remove_dir_all(to);
                return Err(error);
            }
            // Remains of the set-aside copy are in the store folder only, which goes with the
            // record; without a SKILL.md, or the stored copy is put back whole. If neither, the
            // copy at `to` is the one full copy and `from` is gone: the item is restored.
            match set_aside::discard(&aside, from, to) {
                Err(_) if kept_after_failed_move(from, to) => Ok(()),
                result => result,
            }
        }
    }
}

/// An atomic no-replace rename (`renamex_np(RENAME_EXCL)` on macOS, `renameat2(RENAME_NOREPLACE)`
/// on Linux). Elsewhere, or where the file system lacks it, `to` is first claimed with an
/// exclusive `create_dir`, so an occupied path is still refused.
pub(super) fn rename_exclusive(from: &Path, to: &Path) -> std::io::Result<()> {
    if cross_volume() {
        return Err(std::io::Error::other("Cross-device link (test)"));
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use std::os::unix::ffi::OsStrExt;
        let source = std::ffi::CString::new(from.as_os_str().as_bytes())?;
        let target = std::ffi::CString::new(to.as_os_str().as_bytes())?;
        // SAFETY: both arguments are valid NUL-terminated paths that outlive the call.
        #[cfg(target_os = "macos")]
        let result =
            unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) };
        // SAFETY: as above; the raw syscall avoids depending on a glibc wrapper.
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                libc::AT_FDCWD,
                source.as_ptr(),
                libc::AT_FDCWD,
                target.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if !matches!(
            error.raw_os_error(),
            Some(libc::EINVAL | libc::ENOSYS | libc::ENOTSUP)
        ) {
            return Err(error);
        }
    }
    fs::create_dir(to)?;
    // On Unix a directory renames over the empty claim (and fails if anything was put in it).
    #[cfg(unix)]
    let result = fs::rename(from, to);
    #[cfg(not(unix))]
    let result = fs::remove_dir(to).and_then(|()| fs::rename(from, to));
    if result.is_err() {
        let _ = fs::remove_dir(to);
    }
    result
}

pub(super) fn copy_tree(from: &Path, to: &Path, depth: usize) -> std::io::Result<()> {
    if depth > 16 {
        return Err(std::io::Error::other("Folder is nested too deeply"));
    }
    fs::create_dir(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target, depth + 1)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), target)?;
        } else if kind.is_symlink() {
            // Kept as a link on every platform; failing to make one fails the copy.
            links::copy_link(&entry.path(), &target)?;
        }
    }
    Ok(())
}

const OCCUPIED: &str =
    "Something now exists where this skill was installed. Remove it, then turn the skill on again.";

/// Records a restore has claimed: their files are moving, outside `LOCK`.
static RESTORING: std::sync::LazyLock<Mutex<BTreeSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(BTreeSet::new()));

/// Releases claimed records however the restore ends.
struct Claim(Vec<String>);
impl Drop for Claim {
    fn drop(&mut self) {
        let mut restoring = recover(&RESTORING);
        for id in &self.0 {
            restoring.remove(id);
        }
    }
}

/// Moves every quarantined copy of `name` back and clears switches its install set.
/// `lock` is the install lock (`install::ADD`; tests pass their own), taken without waiting as
/// Uninstall does: a folder restored during an add's snapshot → CLI → contain would look newly
/// installed by it, and be quarantined again or deleted.
/// `moved` runs after the files moved and before the records and switches are saved (tests).
/// `LOCK` is held only to choose and claim the records, and again to save them: the folder
/// moves and copies run without it, so switches are never kept waiting.
pub(super) fn restore_with(
    lock: &Mutex<()>,
    prefs_path: &Path,
    name: &str,
    moved: impl FnOnce(),
) -> Result<(), String> {
    let _install = uninstall::claim(lock)?;
    let (selected, _claim) = claim(prefs_path, name)?;
    let mut restored = BTreeSet::new();
    // Names to switch back on, by scope (`None`: All projects).
    let mut unswitch: BTreeMap<Option<String>, BTreeSet<String>> = BTreeMap::new();
    let mut failure = None;
    for entry in &selected {
        match restore_entry(prefs_path, entry) {
            Ok(()) => {
                restored.insert(entry.id.clone());
                unswitch
                    .entry(entry.switched_project.clone())
                    .or_default()
                    .extend(entry.switched.clone().unwrap_or_default());
            }
            Err(error) => {
                failure = Some(error);
                break;
            }
        }
    }
    moved();
    if !restored.is_empty() {
        let _guard = recover(&LOCK);
        // Re-read: an add may have recorded another quarantine meanwhile.
        let mut entries = read(prefs_path)?;
        entries.retain(|entry| !restored.contains(&entry.id));
        write(prefs_path, &entries)?;
        if unswitch.values().any(|names| !names.is_empty()) {
            // And a switch may have changed: only this install's own switches are cleared.
            let mut prefs = read_prefs(prefs_path)?;
            for (project, names) in &unswitch {
                match project {
                    Some(project) => {
                        if let Some(off) = prefs.projects.get_mut(project) {
                            off.retain(|name| !names.contains(name));
                        }
                    }
                    None => prefs.off_in_panda_code.retain(|name| !names.contains(name)),
                }
            }
            prefs.projects.retain(|_, names| !names.is_empty());
            save_prefs(prefs_path, &prefs)?;
        }
    }
    failure.map_or(Ok(()), Err)
}

/// Under `LOCK`: the records holding `name`, claimed for this restore, after dropping records
/// whose quarantined copy is gone and refusing if anything occupies an original path.
fn claim(prefs_path: &Path, name: &str) -> Result<(Vec<Entry>, Claim), String> {
    let _guard = recover(&LOCK);
    let entries = read(prefs_path)?;
    let (selected, kept): (Vec<_>, Vec<_>) = entries
        .into_iter()
        .partition(|e| e.name == name || e.names.contains(name));
    if selected.is_empty() {
        return Err("This skill is not quarantined. Refresh the skill list and try again.".into());
    }
    let mut restoring = recover(&RESTORING);
    if selected.iter().any(|entry| restoring.contains(&entry.id)) {
        return Err("This skill is already being restored.".into());
    }
    // A restore that failed and could not move every item back leaves those items at their
    // original paths (their stored copy gone): they count as already restored, and only the
    // items still in the store are retried.
    let store = store_dir(prefs_path);
    let mut changed = false;
    let mut missing = Vec::new();
    let selected: Vec<_> = selected
        .into_iter()
        .map(|entry| {
            let dir = store.join(&entry.id);
            let (entry, pruned) = prune_restored(entry, &dir);
            changed |= pruned;
            entry
        })
        .collect();
    for entry in &selected {
        let dir = store.join(&entry.id);
        let lost = entry
            .items
            .iter()
            .filter_map(|item| item.stored.as_ref())
            .any(|stored| !dir.join(stored).exists());
        if lost {
            missing.push(entry.id.clone());
        }
    }
    if !missing.is_empty() {
        let remaining: Vec<_> = kept
            .into_iter()
            .chain(selected.into_iter().filter(|e| !missing.contains(&e.id)))
            .collect();
        write(prefs_path, &remaining)?;
        return Err("The quarantined copy of this skill is missing, so it can't be restored. Install it again to use it.".into());
    }
    if changed {
        let all: Vec<_> = kept.iter().chain(&selected).cloned().collect();
        write(prefs_path, &all)?;
    }
    if selected
        .iter()
        .flat_map(|e| &e.items)
        .any(|item| fs::symlink_metadata(&item.original).is_ok())
    {
        return Err(OCCUPIED.into());
    }
    let ids: Vec<_> = selected.iter().map(|entry| entry.id.clone()).collect();
    restoring.extend(ids.iter().cloned());
    Ok((selected, Claim(ids)))
}

/// `entry` without the items already back at their original path: a folder whose stored copy
/// is gone while something is at its original path, or a link already pointing where it did.
/// Returns whether any item was dropped.
pub(super) fn prune_restored(entry: Entry, dir: &Path) -> (Entry, bool) {
    let before = entry.items.len();
    let items: Vec<_> = entry
        .items
        .iter()
        .filter(|item| !already_restored(item, dir))
        .cloned()
        .collect();
    let pruned = items.len() != before;
    (Entry { items, ..entry }, pruned)
}

/// Whether `item` is back at its original path after a failed rollback: it carries the
/// `put_back` mark and is still in place. A stored copy that vanished while something else
/// took the original path is not restored: the record's copy is missing.
pub(super) fn already_restored(item: &Item, dir: &Path) -> bool {
    item.put_back && in_place(item, dir)
}

/// Whether something is at `item`'s original path while its stored copy is gone, or its link
/// already points where it did.
fn in_place(item: &Item, dir: &Path) -> bool {
    match (&item.stored, &item.link) {
        (Some(stored), _) => {
            !dir.join(stored).exists() && fs::symlink_metadata(&item.original).is_ok()
        }
        (None, Some(link)) => fs::read_link(&item.original).is_ok_and(|now| &now == link),
        (None, None) => false,
    }
}

/// Restores one entry completely or not at all.
fn restore_entry(prefs_path: &Path, entry: &Entry) -> Result<(), String> {
    let dir = store_dir(prefs_path).join(&entry.id);
    // Folders first so restored links point at existing targets.
    let mut items: Vec<_> = entry.items.iter().collect();
    items.sort_by_key(|item| item.stored.is_none());
    let mut done: Vec<&Item> = Vec::new();
    for item in items {
        if let Err(error) = restore_item(item, &dir) {
            let left = take_back(&done, &dir);
            if let Err(mark) = mark_put_back(prefs_path, &entry.id, &left) {
                eprintln!("Warning: could not record the items left restored: {mark}");
            }
            return Err(if error.kind() == std::io::ErrorKind::AlreadyExists {
                OCCUPIED.into()
            } else {
                format!("Could not restore the skill: {error}")
            });
        }
        done.push(item);
    }
    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

/// Rolls back a partial restore or Undo: moves the items already put back into `dir` again,
/// newest first, so the kept record still finds them. A folder that can't go back stays where
/// it was restored, never deleted. Returns the original paths of the items left in place:
/// the caller marks them `put_back`, so the next attempt counts them as already back.
pub(super) fn take_back(done: &[&Item], dir: &Path) -> Vec<PathBuf> {
    let mut left = Vec::new();
    for item in done.iter().rev() {
        #[cfg(test)]
        let stuck = STUCK_TAKING_BACK.get();
        #[cfg(not(test))]
        let stuck = false;
        let result = match &item.stored {
            _ if stuck => Err(std::io::Error::other("could not move back (test)")),
            Some(stored) => move_folder(&item.original, &dir.join(stored)),
            None => links::remove_any(&item.original),
        };
        if let Err(error) = result {
            eprintln!(
                "Warning: could not move {} back after a failed restore: {error}",
                item.original.display()
            );
            if in_place(item, dir) {
                left.push(item.original.clone());
            }
        }
    }
    left
}

/// Marks `put_back` on the items of `items` whose original path is in `left`.
pub(super) fn mark_items(items: &mut [Item], left: &[PathBuf]) {
    for item in items.iter_mut().filter(|item| left.contains(&item.original)) {
        item.put_back = true;
    }
}

/// Under `LOCK`: marks the items of record `id` left restored by a failed rollback.
fn mark_put_back(prefs_path: &Path, id: &str, left: &[PathBuf]) -> Result<(), String> {
    if left.is_empty() {
        return Ok(());
    }
    let _guard = recover(&LOCK);
    let mut entries = read(prefs_path)?;
    for entry in entries.iter_mut().filter(|entry| entry.id == id) {
        mark_items(&mut entry.items, left);
    }
    write(prefs_path, &entries)
}

#[cfg(test)]
thread_local! {
    /// Tests: a failed Restore or Undo can't move the items it put back into the store again.
    pub(super) static STUCK_TAKING_BACK: std::cell::Cell<bool> =
        const { std::cell::Cell::new(false) };
}

/// Adds quarantined skills visible in this view. A name with no clean install becomes a
/// quarantined row (Restore in place of its switch). A name that also has a clean install keeps
/// that row switchable; the quarantined copy is added as locations with `quarantined: true` and
/// the row is marked `quarantined_copy`, so the page shows both the switch and Restore.
pub(super) fn add_rows(items: &mut Vec<ManagedSkill>, prefs: &Path, project_id: Option<&str>) {
    let entries = match read(prefs) {
        Ok(entries) => entries,
        Err(error) => {
            eprintln!("Warning: {error}");
            return;
        }
    };
    for entry in entries {
        let agents: Vec<_> = entry
            .agents
            .iter()
            .filter(|a| {
                a.scope == "user" || project_id.is_none() || a.project_id.as_deref() == project_id
            })
            .collect();
        if !entry.agents.is_empty() && agents.is_empty() {
            continue;
        }
        let index = match items.iter().position(|s| s.name == entry.name) {
            Some(index) => index,
            None => {
                items.push(ManagedSkill::new(
                    entry.name.clone(),
                    entry.description.clone(),
                    entry.source.clone(),
                    entry.resolved,
                ));
                items.len() - 1
            }
        };
        let skill = &mut items[index];
        let clean = !skill.quarantined && !skill.missing && !skill.agents.is_empty();
        if !clean {
            skill.missing = false;
            skill.quarantined = true;
            if skill.description.is_empty() {
                skill.description.clone_from(&entry.description);
            }
        } else {
            skill.quarantined_copy = true;
        }
        for agent in agents {
            let listed = skill.agents.iter().any(|a| {
                a.harness == agent.harness && a.scope == agent.scope && a.path == agent.path
            });
            if !listed {
                skill.agents.push(SkillAgent {
                    harness: agent.harness.clone(),
                    scope: agent.scope.clone(),
                    path: agent.path.clone(),
                    project_id: agent.project_id.clone(),
                    quarantined: clean,
                    real: None,
                });
            }
        }
        let room = MAX_FLAGS.saturating_sub(skill.flags.len());
        skill.flags.extend(entry.flags.into_iter().take(room));
    }
    items.sort_by(|a, b| a.name.cmp(&b.name));
}

/// Names (row and identity) of every quarantined skill, for switch validation.
pub(super) fn names(prefs: &Path) -> BTreeSet<String> {
    read(prefs)
        .unwrap_or_default()
        .into_iter()
        .flat_map(|e| std::iter::once(e.name).chain(e.names))
        .collect()
}

#[cfg(test)]
#[path = "quarantine_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "cross_volume_tests.rs"]
mod cross_volume_tests;
