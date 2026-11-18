//! Hidden set-aside folders (`.<name>.removing-<id>`): where a move across volumes puts the
//! original once its copy is complete, so the name is free in one step before the delete.
use super::*;

const MARKER: &str = ".removing-";

/// A free, hidden name beside `from` for a folder being deleted (no record refers to it).
/// Dot-prefixed, so agents scanning a skill root skip what a failed delete leaves behind.
pub(super) fn path(from: &Path) -> PathBuf {
    let name = from.file_name().unwrap_or_default().to_string_lossy();
    from.with_file_name(format!(".{name}{MARKER}{}", uuid::Uuid::new_v4()))
}

/// Whether a folder name is a set-aside folder (`.<name>.removing-<id>`): the inventory never
/// lists one, even if a delete left files in it.
pub(in crate::skill_manager) fn is_set_aside(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy();
    name.starts_with('.')
        && name[1..]
            .find(MARKER)
            .is_some_and(|at| at > 0 && name.len() > 1 + at + MARKER.len())
}

/// Deletes `aside`, the original of a move whose copy at `to` is complete. Every top-level
/// SKILL.md entry (any case) is first renamed to a hidden name inside `aside`; only once all
/// are renamed does anything get deleted, so remains a failed delete leaves are never a skill.
/// If a rename fails, the renamed entries go back, the move is undone (`aside` back to `from`,
/// the copy at `to` removed) and the error returned. If that rollback fails too, the copy at
/// `to` is kept (the one full copy) and an error returned with `from` gone: callers must keep
/// `to` (see `quarantine::kept_after_failed_move`). Other remains are only reported.
pub(super) fn discard(aside: &Path, from: &Path, to: &Path) -> std::io::Result<()> {
    let hidden = match hide_skill_md(aside) {
        Ok(hidden) => hidden,
        Err((error, hidden)) => return undo(aside, from, to, &hidden, error),
    };
    // The move stands: nothing in `aside` is named SKILL.md any more.
    for (temporary, _) in &hidden {
        if let Err(error) = remove_entry(temporary) {
            eprintln!("Warning: could not remove {}: {error}", temporary.display());
        }
    }
    if let Err(error) = fs::remove_dir_all(aside) {
        eprintln!("Warning: could not remove {}: {error}", aside.display());
    }
    Ok(())
}

/// Undoes a move whose SKILL.md step failed with `error`, after `hidden` entries were renamed.
fn undo(
    aside: &Path,
    from: &Path,
    to: &Path,
    hidden: &[(PathBuf, PathBuf)],
    error: std::io::Error,
) -> std::io::Result<()> {
    let failed = std::io::Error::new(
        error.kind(),
        format!("could not move {}: {error}", from.display()),
    );
    let back = unhide(hidden).and_then(|()| fs::rename(aside, from));
    if let Err(back) = back {
        // `aside` may lack its SKILL.md now: the copy at `to` is the one full copy.
        eprintln!(
            "Warning: could not set aside the skill file in {} ({error}) or move it back: {back}; \
             the copy at {} is kept",
            aside.display(),
            to.display()
        );
        return Err(failed);
    }
    if let Err(cleanup) = fs::remove_dir_all(to) {
        eprintln!("Warning: could not remove {}: {cleanup}", to.display());
    }
    Err(failed)
}

/// Renames every top-level entry of `folder` named SKILL.md in any case to a hidden name in
/// `folder`. Returns the (temporary, original) pairs; on failure also those renamed so far.
type Hidden = Vec<(PathBuf, PathBuf)>;
fn hide_skill_md(folder: &Path) -> Result<Hidden, (std::io::Error, Hidden)> {
    let mut hidden = Vec::new();
    let names = skill_md_names(folder).map_err(|e| (e, Vec::new()))?;
    for name in names {
        let original = folder.join(&name);
        let temporary = folder.join(format!(".skill-md{MARKER}{}", uuid::Uuid::new_v4()));
        if let Err(error) = fs::rename(&original, &temporary) {
            return Err((error, hidden));
        }
        hidden.push((temporary, original));
    }
    Ok(hidden)
}

/// Renames hidden entries back, newest first. Every one is tried; returns the first error.
fn unhide(hidden: &[(PathBuf, PathBuf)]) -> std::io::Result<()> {
    #[cfg(test)]
    if STUCK_RENAMING_BACK.take() {
        return Err(std::io::Error::other("rename back failed (test)"));
    }
    let mut first = Ok(());
    for (temporary, original) in hidden.iter().rev() {
        if let Err(error) = fs::rename(temporary, original) {
            if first.is_ok() {
                first = Err(error);
            }
        }
    }
    first
}

/// The top-level entry names of `folder` that are SKILL.md in any case, sorted.
fn skill_md_names(folder: &Path) -> std::io::Result<Vec<std::ffi::OsString>> {
    #[cfg(test)]
    if KEEP_SKILL_MD.get() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "Permission denied (test)",
        ));
    }
    let mut names = Vec::new();
    for entry in fs::read_dir(folder)? {
        let name = entry?.file_name();
        if name.to_string_lossy().eq_ignore_ascii_case("SKILL.md") {
            names.push(name);
        }
    }
    names.sort();
    // Tests: a second entry follows whose rename fails (it does not exist).
    #[cfg(test)]
    if SECOND_SKILL_MD_STUCK.take() {
        names.push(".missing-skill.MD".into());
    }
    Ok(names)
}

/// Deletes a renamed entry: a folder with its contents, anything else (a link too) itself.
fn remove_entry(path: &Path) -> std::io::Result<()> {
    if fs::symlink_metadata(path)?.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

#[cfg(test)]
thread_local! {
    /// Tests: setting aside a SKILL.md fails on this thread before any is renamed.
    pub(in crate::skill_manager) static KEEP_SKILL_MD: std::cell::Cell<bool> =
        const { std::cell::Cell::new(false) };
    /// Tests, once: after the real SKILL.md entries, one more fails to be renamed.
    pub(in crate::skill_manager) static SECOND_SKILL_MD_STUCK: std::cell::Cell<bool> =
        const { std::cell::Cell::new(false) };
    /// Tests, once: renaming set-aside SKILL.md entries back fails.
    pub(in crate::skill_manager) static STUCK_RENAMING_BACK: std::cell::Cell<bool> =
        const { std::cell::Cell::new(false) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_manager_set_aside_names_are_recognised() {
        let aside = path(Path::new("/root/tidy"));
        assert!(is_set_aside(aside.file_name().unwrap()));
        for name in [".tidy.removing-1", "..x.removing-a"] {
            assert!(is_set_aside(std::ffi::OsStr::new(name)), "{name}");
        }
        for name in ["tidy.removing-1", ".removing-1", ".tidy.removing-", ".system", "tidy"] {
            assert!(!is_set_aside(std::ffi::OsStr::new(name)), "{name}");
        }
    }
}
