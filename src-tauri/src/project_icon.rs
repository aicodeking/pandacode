//! The app's own icon for a project, for its sidebar rows: the first favicon or app icon
//! found in the usual places (web `public/` and `static/` folders, Next.js `app/`, Tauri
//! and Electron icon folders, the project root), returned as a `data:` URL the webview
//! can show without file access. Only small image files are read; anything else falls
//! back to the sidebar's default icon.
use std::io::Read;
use std::path::Path;

use base64::Engine;

const LIMIT: u64 = 256 * 1024;

/// Checked in order; the first readable image wins. Vector and larger icons come first.
const CANDIDATES: &[&str] = &[
    "public/favicon.svg", "public/icon.svg", "public/logo.svg", "public/apple-touch-icon.png",
    "public/favicon.png", "public/icon.png", "public/logo.png", "public/favicon.ico",
    "static/favicon.svg", "static/favicon.png", "static/favicon.ico",
    "app/icon.svg", "app/icon.png", "app/apple-icon.png", "app/favicon.ico",
    "src/app/icon.svg", "src/app/icon.png", "src/app/apple-icon.png", "src/app/favicon.ico",
    "src/assets/icon.svg", "src/assets/logo.svg", "src/assets/icon.png", "src/assets/logo.png",
    "assets/icon.svg", "assets/icon.png", "assets/logo.svg", "assets/logo.png",
    "src-tauri/icons/128x128.png", "src-tauri/icons/icon.png",
    "build/icon.png", "resources/icon.png",
    "favicon.svg", "favicon.png", "favicon.ico", "icon.svg", "icon.png", "logo.svg", "logo.png",
];

fn media_type(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        _ => "image/png",
    }
}

/// The project's icon as a `data:` URL, or None when it has none we can show.
pub fn find(root: &Path) -> Option<String> {
    let base = root.canonicalize().ok()?;
    for candidate in CANDIDATES {
        let Some(bytes) = read_icon(&base, candidate) else { continue };
        if !looks_like(candidate, &bytes) {
            continue;
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Some(format!("data:{};base64,{encoded}", media_type(candidate)));
    }
    None
}

/// Reads one candidate under the canonical `base`, or None. `projects.icons` serves this to
/// phones at View access, so it never leaves the project: the path must resolve inside `base`
/// (a symlinked `public/` pointing elsewhere is refused), the file itself is opened without
/// following a symlink, and the opened handle must be a small regular file with one hard link
/// that is the very file the path resolved to.
fn read_icon(base: &Path, candidate: &str) -> Option<Vec<u8>> {
    let path = base.join(candidate);
    let resolved = path.canonicalize().ok()?;
    if !resolved.starts_with(base) {
        return None;
    }
    let checked = std::fs::metadata(&resolved).ok()?;
    if !checked.is_file() {
        return None;
    }
    let file = open_no_follow(&path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > LIMIT || !single_link_same_file(&meta, &checked) {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1).read_to_end(&mut bytes).ok()?;
    (!bytes.is_empty() && bytes.len() as u64 <= LIMIT).then_some(bytes)
}

/// Opens `path` for reading without following a symlink at its last component (and without
/// blocking on a FIFO swapped in after the checks).
fn open_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path)
    }
    #[cfg(not(unix))]
    {
        if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
            return Err(std::io::ErrorKind::InvalidInput.into());
        }
        std::fs::File::open(path)
    }
}

/// Whether the opened file has exactly one hard link and is the file `checked` describes.
#[cfg(unix)]
fn single_link_same_file(opened: &std::fs::Metadata, checked: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    opened.nlink() == 1 && opened.dev() == checked.dev() && opened.ino() == checked.ino()
}
#[cfg(not(unix))]
fn single_link_same_file(_opened: &std::fs::Metadata, _checked: &std::fs::Metadata) -> bool {
    true
}

/// A cheap check that the file is the image its name says, so a stray text file or an
/// unrelated binary named `icon.png` never reaches the sidebar.
fn looks_like(path: &str, bytes: &[u8]) -> bool {
    match media_type(path) {
        "image/svg+xml" => {
            let head = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]).to_ascii_lowercase();
            head.contains("<svg")
        }
        "image/x-icon" => bytes.starts_with(&[0, 0, 1, 0]) || bytes.starts_with(b"\x89PNG"),
        _ => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("pandacode-icon-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn finds_the_first_real_icon_in_the_usual_places() {
        let root = project();
        assert_eq!(find(&root), None);
        std::fs::create_dir_all(root.join("public")).unwrap();
        std::fs::write(root.join("public/favicon.ico"), [0u8, 0, 1, 0, 1, 0]).unwrap();
        assert!(find(&root).unwrap().starts_with("data:image/x-icon;base64,"));
        std::fs::write(root.join("public/favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap();
        assert!(find(&root).unwrap().starts_with("data:image/svg+xml;base64,"), "an SVG is preferred");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skips_files_that_are_not_what_they_claim_or_are_too_large() {
        let root = project();
        std::fs::write(root.join("icon.png"), "not a png").unwrap();
        std::fs::write(root.join("logo.svg"), vec![b'x'; (LIMIT + 1) as usize]).unwrap();
        assert_eq!(find(&root), None);
        std::fs::write(root.join("favicon.png"), b"\x89PNG\r\n\x1a\nrest").unwrap();
        assert!(find(&root).unwrap().starts_with("data:image/png;base64,"));
        std::fs::remove_dir_all(root).unwrap();
    }
    /// `projects.icons` is a View method: an icon name must never read a file outside the project.
    #[cfg(unix)]
    #[test]
    fn never_reads_through_symlinks_or_hard_links() {
        let root = project();
        let outside = project();
        std::fs::write(outside.join("favicon.svg"), "<svg>outside</svg>").unwrap();
        std::fs::write(outside.join("logo.png"), b"\x89PNG\r\n\x1a\nsecret").unwrap();
        // A symlinked `public` folder pointing outside the project.
        std::os::unix::fs::symlink(&outside, root.join("public")).unwrap();
        assert_eq!(find(&root), None, "symlinked folder");
        // A symlinked icon file.
        std::os::unix::fs::symlink(outside.join("favicon.svg"), root.join("favicon.svg")).unwrap();
        assert_eq!(find(&root), None, "symlinked file");
        // A hard-linked icon (its other name may be anywhere).
        std::fs::hard_link(outside.join("logo.png"), root.join("logo.png")).unwrap();
        assert_eq!(find(&root), None, "hard-linked file");
        // A plain icon still works alongside them.
        std::fs::write(root.join("icon.png"), b"\x89PNG\r\n\x1a\nmine").unwrap();
        let url = find(&root).unwrap();
        let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nmine");
        assert_eq!(url, format!("data:image/png;base64,{png}"));
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }
}
