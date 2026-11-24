//! Path spelling and folder matching shared by harness launch, background exits, warm spares and
//! checkout-busy checks: the ordinary Win32 spelling of an extended Windows path, best-effort
//! canonical paths that survive a deleted folder, and "does this path lie inside that folder".
//! Pure path logic with no dependency on any provider module.
use std::path::{Component, Path, PathBuf};

/// Canonical Windows paths are useful for native file operations, but Node and
/// ACP servers may interpret the extended namespace as part of the drive name.
/// Only simplify paths with ordinary Win32 semantics; device/long/special paths
/// must retain their prefix rather than silently refer to a different file.
pub(crate) fn external_path(path: &Path) -> PathBuf {
    external_path_for(path, cfg!(windows))
}

/// [`external_path`] with the platform passed in, so every platform tests the Windows rules.
pub(crate) fn external_path_for(path: &Path, windows: bool) -> PathBuf {
    if windows {
        if let Some(text) = path.to_str() {
            if let Some(path) = ordinary_windows_path(text) {
                return path.into();
            }
        }
    }
    path.to_owned()
}

/// The ordinary spelling of a `\\?\` extended path, or `None` when dropping the prefix could
/// change which file the path names (device names, trailing dots or spaces, overlong paths).
pub(crate) fn ordinary_windows_path(path: &str) -> Option<String> {
    let extended = path.strip_prefix(r"\\?\")?;
    let ordinary = if let Some(unc) = extended.strip_prefix(r"UNC\") {
        if unc.split('\\').filter(|part| !part.is_empty()).count() < 2 {
            return None;
        }
        format!(r"\\{unc}")
    } else if extended.as_bytes().get(1..3) == Some(b":\\")
        && extended.as_bytes()[0].is_ascii_alphabetic()
    {
        extended.to_owned()
    } else {
        return None;
    };
    if ordinary.encode_utf16().count() >= 260 {
        return None;
    }
    for part in ordinary.split('\\').filter(|part| !part.is_empty()) {
        let name = part.split('.').next().unwrap_or_default().to_ascii_uppercase();
        if part.ends_with([' ', '.'])
            || part.contains(['/', '*', '?'])
            || matches!(name.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
            || (name.len() == 4
                && (name.starts_with("COM") || name.starts_with("LPT"))
                && matches!(name.as_bytes()[3], b'1'..=b'9'))
            || ["COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³"].contains(&name.as_str())
        {
            return None;
        }
    }
    Some(ordinary)
}

/// Best-effort canonical path: uses `canonicalize` when `path` exists, and otherwise
/// canonicalizes the deepest existing ancestor so deleted folders (e.g. during
/// `recreate_worktree`) still match spares recorded under a canonical or symlinked spelling.
pub(crate) fn resolve_path(path: &Path) -> PathBuf {
    if let Ok(canonical) = path.canonicalize() {
        return external_path(&canonical);
    }
    let mut suffix = Vec::new();
    let mut cursor = path;
    loop {
        if let Ok(canonical) = cursor.canonicalize() {
            let mut resolved = external_path(&canonical);
            for component in suffix.into_iter().rev() {
                match component {
                    Component::CurDir => {}
                    Component::ParentDir => {
                        resolved.pop();
                    }
                    other => resolved.push(other.as_os_str()),
                }
            }
            return resolved;
        }
        let Some(parent) = cursor.parent() else {
            return external_path(path);
        };
        if let Some(last) = cursor.components().next_back() {
            suffix.push(last);
        }
        if parent == cursor {
            return external_path(path);
        }
        cursor = parent;
    }
}

/// Whether `path` spells a `..` segment, which a literal prefix match would wrongly treat as a
/// child name (`root/../other` starts with `root`).
fn has_parent_dir(path: &Path) -> bool {
    path.components().any(|component| matches!(component, Component::ParentDir))
}

/// Whether `candidate` lies inside (or equals) `folder`, literally or once both resolve
/// through [`resolve_path`]. `folder_resolved` is `resolve_path(folder)` computed once.
/// Literal prefix matches are trusted only when neither spelling contains `..`.
pub(crate) fn path_in_folder(candidate: &Path, folder: &Path, folder_resolved: &Path) -> bool {
    let candidate_ext = external_path(candidate);
    let folder_ext = external_path(folder);
    if candidate_ext == folder_ext || candidate_ext == folder_resolved {
        return true;
    }
    if !has_parent_dir(&candidate_ext)
        && !has_parent_dir(&folder_ext)
        && (candidate_ext.starts_with(&folder_ext) || candidate_ext.starts_with(folder_resolved))
    {
        return true;
    }
    let resolved = resolve_path(candidate);
    resolved == folder_resolved || resolved.starts_with(folder_resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extended_windows_paths_lose_only_safe_namespace_prefixes() {
        for (extended, ordinary) in [
            (r"\\?\C:\project", r"C:\project"),
            (r"\\?\UNC\server\share\project", r"\\server\share\project"),
            (r"\\?\C:\", r"C:\"),
        ] {
            assert_eq!(ordinary_windows_path(extended).as_deref(), Some(ordinary));
            assert_eq!(external_path_for(Path::new(extended), true), Path::new(ordinary));
            assert_eq!(external_path_for(Path::new(extended), false), Path::new(extended));
        }
        for path in [r"C:\project", "/tmp/project", r"\\.\pipe\agent", r"\\?\Volume{abc}\project", r"\\?\C:\trailing.", r"\\?\C:\NUL.txt", r"\\?\C:\COM1", r"\\?\UNC\server"] {
            assert_eq!(ordinary_windows_path(path), None, "{path}");
            assert_eq!(external_path_for(Path::new(path), true), Path::new(path));
        }
        assert!(ordinary_windows_path(&format!(r"\\?\C:\{}", "x".repeat(260))).is_none());
    }

    #[test]
    fn folders_match_literally_canonically_and_after_deletion() {
        let base = std::env::temp_dir().join(format!("pandacode-path-match-{}", uuid::Uuid::new_v4().simple()));
        let folder = base.join("wt");
        let nested = folder.join("sub").join("dir");
        let sibling = base.join("wt-other");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let resolved = resolve_path(&folder);
        assert_eq!(resolved, external_path(&folder.canonicalize().unwrap()));
        assert!(path_in_folder(&folder, &folder, &resolved));
        assert!(path_in_folder(&folder.join("."), &folder, &resolved));
        assert!(path_in_folder(&nested, &folder, &resolved));
        assert!(!path_in_folder(&sibling, &folder, &resolved), "a name prefix is not a parent folder");
        assert!(!path_in_folder(&base, &folder, &resolved), "a parent is not inside its child");
        let canonical_folder = folder.canonicalize().unwrap();
        let canonical_nested = nested.canonicalize().unwrap();
        std::fs::remove_dir_all(&folder).unwrap();
        let deleted = resolve_path(&folder);
        assert_eq!(deleted, external_path(&canonical_folder), "the deepest existing ancestor resolves a deleted folder");
        assert_eq!(resolve_path(&folder.join("sub").join("..")), deleted);
        assert!(path_in_folder(&canonical_folder, &folder, &deleted));
        assert!(path_in_folder(&canonical_nested, &folder, &deleted));
        assert!(!path_in_folder(&sibling, &folder, &deleted));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn parent_dir_segments_never_match_literally() {
        let base = std::env::temp_dir().join(format!("pandacode-path-match-dots-{}", uuid::Uuid::new_v4().simple()));
        let root = base.join("root");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(base.join("other")).unwrap();
        let resolved = resolve_path(&root);
        for (candidate, inside) in [
            (root.join("..").join("other"), false),
            (root.join("..").join("missing"), false),
            (root.join("sub").join("..").join("inside"), true),
            (root.join("sub").join("..").join("sub"), true),
            (root.join("sub").join("..").join(".."), false),
        ] {
            assert_eq!(path_in_folder(&candidate, &root, &resolved), inside, "{}", candidate.display());
        }
        let dotted_folder = root.join("sub").join("..");
        assert!(path_in_folder(&root.join("sub"), &dotted_folder, &resolve_path(&dotted_folder)));
        assert!(!path_in_folder(&base.join("other"), &dotted_folder, &resolve_path(&dotted_folder)));
        let _ = std::fs::remove_dir_all(base);
    }
}
