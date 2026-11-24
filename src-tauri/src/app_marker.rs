//! On/off settings saved as the presence of an empty file in app data, read at every run start
//! so the desktop app and `pandacode serve` share them. Readers pick their own safe value for an
//! `Err` (the marker could not be checked).
use std::path::{Path, PathBuf};
use tauri::Manager;

type Result<T> = std::result::Result<T, String>;

pub(crate) fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf> {
    Ok(data_dir(app)?.join(name))
}

pub(crate) fn exists(app: &tauri::AppHandle, name: &str) -> Result<bool> {
    exists_in(data_dir(app), name)
}

/// Whether marker `name` is present in `dir`; an unavailable `dir` is an `Err`.
pub(crate) fn exists_in(dir: Result<PathBuf>, name: &str) -> Result<bool> {
    exists_at(dir.map(|dir| dir.join(name)))
}

pub(crate) fn set(app: &tauri::AppHandle, name: &str, present: bool) -> Result<()> {
    set_at(&path(app, name)?, present)
}

fn exists_at(path: Result<PathBuf>) -> Result<bool> {
    let path = path?;
    match path.try_exists() {
        Ok(true) => Ok(true),
        Ok(false) => {
            // On Windows, `try_exists()` maps `ERROR_PATH_NOT_FOUND` under a non-directory
            // ancestor to `Ok(false)` instead of `ENOTDIR`. Walk up to the nearest existing
            // ancestor and fail closed if it is not a directory.
            for ancestor in path.ancestors().skip(1) {
                match std::fs::metadata(ancestor) {
                    Ok(meta) => {
                        return if meta.is_dir() {
                            Ok(false)
                        } else {
                            Err("Could not read the setting: app data path is not a directory".into())
                        };
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(format!("Could not read the setting: {error}")),
                }
            }
            Ok(false)
        }
        Err(error) => Err(format!("Could not read the setting: {error}")),
    }
}

fn set_at(path: &Path, present: bool) -> Result<()> {
    let saved = if present {
        path.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|()| std::fs::write(path, ""))
    } else {
        std::fs::remove_file(path).or_else(|error| if error.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(error) })
    };
    saved.map_err(|error| format!("Could not save the setting: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_and_exists_round_trip_and_fail_safe() {
        let dir = std::env::temp_dir().join(format!("app-marker-{}", uuid::Uuid::new_v4()));
        let marker = dir.join("nested").join("flag");
        assert_eq!(exists_at(Ok(marker.clone())), Ok(false));
        set_at(&marker, true).unwrap();
        assert_eq!(exists_at(Ok(marker.clone())), Ok(true));
        set_at(&marker, true).unwrap();
        set_at(&marker, false).unwrap();
        set_at(&marker, false).unwrap();
        assert_eq!(exists_at(Ok(marker.clone())), Ok(false));
        // No app data, or a marker under a file ("not a directory", not "not found"): an error,
        // never a guess, so each reader chooses its safe default.
        assert!(exists_at(Err("no app data".into())).is_err());
        std::fs::write(dir.join("file"), "").unwrap();
        let unreadable = dir.join("file").join("flag");
        assert!(exists_at(Ok(unreadable.clone())).is_err());
        assert!(set_at(&unreadable, true).unwrap_err().starts_with("Could not save the setting"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
