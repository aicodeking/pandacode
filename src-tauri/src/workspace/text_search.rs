//! Find-in-files for the inspector's Search view: a bounded, ignore-aware walk
//! that returns matching lines with highlight ranges in UTF-16 units for the UI.
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const MAX_MATCHES: usize = 2_000;
const MAX_FILES: usize = 50_000;
const MAX_ENTRIES: usize = 200_000;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const MAX_FILE_BYTES: u64 = 1024 * 1024;
const PREVIEW_CHARS: usize = 300;
const CONTEXT_BEFORE: usize = 40;
const DEADLINE: Duration = Duration::from_secs(5);

/// A new search in a folder supersedes the one still walking it; the UI only shows the latest query.
fn generations() -> std::sync::MutexGuard<'static, HashMap<PathBuf, u64>> {
    static LATEST: OnceLock<Mutex<HashMap<PathBuf, u64>>> = OnceLock::new();
    LATEST.get_or_init(Default::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A regex for `word` as a whole word. Like VS Code, an edge that is not a word character needs
/// no boundary (`@foo`, `foo()`).
pub(crate) fn whole_word_pattern(word: &str) -> String {
    let is_word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
    let before = if is_word(word.chars().next()) { r"\b" } else { "" };
    let after = if is_word(word.chars().next_back()) { r"\b" } else { "" };
    format!("{before}{}{after}", regex::escape(word))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextMatch {
    pub line: usize,
    pub text: String,
    pub ranges: Vec<[usize; 2]>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFileMatches {
    pub path: String,
    pub matches: Vec<TextMatch>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSearchResult {
    pub files: Vec<TextFileMatches>,
    pub truncated: bool,
}

pub fn search_text(
    root: &Path,
    query: &str,
    match_case: bool,
    whole_word: bool,
    regex: bool,
) -> Result<TextSearchResult, String> {
    search_text_with(root, query, match_case, whole_word, regex, false)
}

/// [`search_text`] for a phone (`files.grep`): files with more than one hard link are never
/// read, as `files.read` refuses them (docs/remote-access.md, "No hard-linked files").
pub fn search_text_for_phone(
    root: &Path,
    query: &str,
    match_case: bool,
    whole_word: bool,
    regex: bool,
) -> Result<TextSearchResult, String> {
    search_text_with(root, query, match_case, whole_word, regex, true)
}

fn search_text_with(
    root: &Path,
    query: &str,
    match_case: bool,
    whole_word: bool,
    regex: bool,
    skip_links: bool,
) -> Result<TextSearchResult, String> {
    if query.is_empty() || query.len() > 512 || query.contains('\0') {
        return Err("Search text must be 1 to 512 bytes and contain no null characters.".into());
    }
    let pattern = if regex { query.to_owned() } else { regex::escape(query) };
    let pattern = match (whole_word, regex) {
        (false, _) => pattern,
        (true, true) => format!(r"\b(?:{pattern})\b"),
        (true, false) => whole_word_pattern(query),
    };
    let matcher = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!match_case)
        .size_limit(1 << 20)
        .build()
        .map_err(|error| format!("Invalid regular expression: {error}"))?;
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("Project folder is unavailable.".into());
    }
    let walker = super::project_walker(&root)
        .filter_entry(|entry| {
            !super::file_search::excluded(entry.file_name(), entry.file_type().is_some_and(|t| t.is_dir()))
        })
        .build();
    let generation = {
        let mut latest = generations();
        let next = latest.get(&root).copied().unwrap_or(0) + 1;
        latest.insert(root.clone(), next);
        next
    };
    let started = Instant::now();
    let (mut files, mut total, mut scanned, mut entries, mut bytes_read) = (Vec::<TextFileMatches>::new(), 0, 0, 0usize, 0u64);
    for entry in walker.flatten() {
        // Directories count too, so a huge tree of empty folders still stops.
        if generations().get(&root) != Some(&generation) {
            return Err("Search was replaced by a newer one.".into());
        }
        entries += 1;
        if entries > MAX_ENTRIES || started.elapsed() > DEADLINE {
            files.sort_by(|a, b| a.path.cmp(&b.path));
            return Ok(TextSearchResult { files, truncated: true });
        }
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        scanned += 1;
        if scanned > MAX_FILES || bytes_read >= MAX_TOTAL_BYTES {
            files.sort_by(|a, b| a.path.cmp(&b.path));
            return Ok(TextSearchResult { files, truncated: true });
        }
        let Some(bytes) = read_inside(&root, entry.path(), skip_links) else { continue };
        bytes_read += bytes.len() as u64;
        // Binary and non-UTF-8 files are skipped, as in VS Code's default search.
        if bytes[..bytes.len().min(8192)].contains(&0) {
            continue;
        }
        let Ok(content) = String::from_utf8(bytes) else { continue };
        let mut matches = Vec::new();
        for (index, line) in content.split('\n').enumerate() {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let spans: Vec<_> = matcher
                .find_iter(line)
                .filter(|m| m.start() < m.end())
                .take(MAX_MATCHES - total)
                .map(|m| (m.start(), m.end()))
                .collect();
            if spans.is_empty() {
                continue;
            }
            total += spans.len();
            matches.push(preview(line, index + 1, &spans));
            if total >= MAX_MATCHES {
                break;
            }
        }
        // Names that are not valid Unicode could not be reopened from the UI.
        let path = entry.path().strip_prefix(&root).ok().and_then(Path::to_str);
        if let (false, Some(path)) = (matches.is_empty(), path) {
            #[cfg(windows)]
            let path = path.replace('\\', "/");
            files.push(TextFileMatches { path: path.to_owned(), matches });
        }
        if total >= MAX_MATCHES {
            files.sort_by(|a, b| a.path.cmp(&b.path));
            return Ok(TextSearchResult { files, truncated: true });
        }
    }
    // The walk is unsorted (sorting would buffer whole directories); order the bounded result.
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(TextSearchResult { files, truncated: false })
}

/// Reads a regular file through one opened handle, refusing it if the path is (or became) a
/// symlink, resolves outside `root`, or is no longer the file that was opened; `skip_links`
/// also refuses a file with more than one hard link (checked on the opened handle).
fn read_inside(root: &Path, path: &Path, skip_links: bool) -> Option<Vec<u8>> {
    read_checked(root, path, MAX_FILE_BYTES, |_| false, skip_links)
}

/// Opens without waiting: a FIFO swapped in after the type check opens at once and is refused.
/// Returns the file and its metadata.
fn open_regular(path: &Path) -> Option<(std::fs::File, std::fs::Metadata)> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path).ok()?;
    let metadata = file.metadata().ok()?;
    metadata.is_file().then_some((file, metadata))
}

/// `refused` judges the opened file's real path, relative to `root`.
pub(crate) fn read_inside_up_to(root: &Path, path: &Path, limit: u64, refused: impl Fn(&str) -> bool) -> Option<Vec<u8>> {
    read_checked(root, path, limit, refused, false)
}

fn read_checked(root: &Path, path: &Path, limit: u64, refused: impl Fn(&str) -> bool, skip_links: bool) -> Option<Vec<u8>> {
    use std::io::Read;
    let (file, size) = open_checked(root, path, limit, refused, skip_links)?;
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(limit + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= limit).then_some(bytes)
}

/// `read_inside_up_to`'s checks without the read: the opened file and its size, for a caller
/// that streams it.
pub(crate) fn open_inside_up_to(root: &Path, path: &Path, limit: u64, refused: impl Fn(&str) -> bool) -> Option<(std::fs::File, u64)> {
    open_checked(root, path, limit, refused, false)
}

fn open_checked(root: &Path, path: &Path, limit: u64, refused: impl Fn(&str) -> bool, skip_links: bool) -> Option<(std::fs::File, u64)> {
    // Checked before opening: opening a FIFO would wait for a writer.
    if !std::fs::symlink_metadata(path).ok()?.file_type().is_file() {
        return None;
    }
    let (file, opened) = open_regular(path)?;
    if opened.len() > limit {
        return None;
    }
    // Judged by where the opened handle is now, never by looking the path up again: a folder
    // swapped for a symlink since the caller's checks may lead elsewhere inside the root.
    let real = handle_path(&file, path)?;
    if real.strip_prefix(root).ok().is_none_or(|inside| refused(&inside.to_string_lossy())) {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let now = std::fs::symlink_metadata(path).ok()?;
        if (now.dev(), now.ino()) != (opened.dev(), opened.ino()) {
            return None;
        }
        if skip_links && opened.nlink() > 1 {
            return None;
        }
    }
    #[cfg(not(unix))]
    let _ = skip_links;
    Some((file, opened.len()))
}

/// The real path of the file `file` has open (macOS `F_GETPATH`, Linux `/proc/self/fd`).
#[cfg(target_os = "macos")]
fn handle_path(file: &std::fs::File, _path: &Path) -> Option<std::path::PathBuf> {
    use std::os::unix::{ffi::OsStrExt, io::AsRawFd};
    let mut buffer = vec![0u8; libc::PATH_MAX as usize];
    // SAFETY: F_GETPATH writes a NUL-terminated path of at most PATH_MAX bytes into the buffer.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) } == -1 {
        return None;
    }
    let length = buffer.iter().position(|&byte| byte == 0)?;
    Some(std::ffi::OsStr::from_bytes(&buffer[..length]).into())
}

#[cfg(target_os = "linux")]
fn handle_path(file: &std::fs::File, _path: &Path) -> Option<std::path::PathBuf> {
    use std::os::unix::io::AsRawFd;
    // A file deleted since opening reads `… (deleted)`; the inode check after this refuses it.
    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).ok()
}

/// Windows: the handle's final path, in the `\\?\` form `canonicalize` gives the root.
#[cfg(windows)]
fn handle_path(file: &std::fs::File, _path: &Path) -> Option<std::path::PathBuf> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED},
    };
    let mut buffer = vec![0u16; 32768];
    // SAFETY: the handle is open for the call and the buffer's length is passed with it.
    let length = unsafe { GetFinalPathNameByHandleW(HANDLE(file.as_raw_handle()), &mut buffer, FILE_NAME_NORMALIZED) } as usize;
    (length > 0 && length < buffer.len()).then(|| std::ffi::OsString::from_wide(&buffer[..length]).into())
}

// ponytail: other platforms resolve the path again, not the handle, so a folder swapped in
// between can pass; add their handle lookup if one is ever shipped.
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn handle_path(_file: &std::fs::File, path: &Path) -> Option<std::path::PathBuf> {
    path.canonicalize().ok()
}

/// A trimmed window of the line around its first match; ranges are UTF-16 offsets into it.
fn preview(line: &str, number: usize, spans: &[(usize, usize)]) -> TextMatch {
    // A match may begin inside the leading whitespace (`\s+`); never trim past it.
    let mut start = (line.len() - line.trim_start().len()).min(spans[0].0);
    if line[start..spans[0].0].chars().count() > CONTEXT_BEFORE * 2 {
        start = spans[0].0;
        for _ in 0..CONTEXT_BEFORE {
            start -= line[..start].chars().next_back().map_or(0, char::len_utf8);
        }
    }
    let end = line[start..].char_indices().nth(PREVIEW_CHARS).map_or(line.len(), |(i, _)| start + i);
    let utf16 = |to: usize| line[start..to].encode_utf16().count();
    let ranges = spans
        .iter()
        .filter(|(s, _)| *s >= start && *s < end)
        .map(|&(s, e)| [utf16(s), utf16(e.min(end))])
        .collect();
    TextMatch { line: number, text: line[start..end].to_owned(), ranges }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("pandacode-text-search-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            Self(root.canonicalize().unwrap())
        }
        fn write(&self, path: &str, content: impl AsRef<[u8]>) {
            let path = self.0.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
        fn search(&self, query: &str, case: bool, word: bool, regex: bool) -> TextSearchResult {
            search_text(&self.0, query, case, word, regex).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn hits(result: &TextSearchResult) -> Vec<(String, usize)> {
        result.files.iter().flat_map(|f| f.matches.iter().map(|m| (f.path.clone(), m.line))).collect()
    }

    #[test]
    fn finds_lines_with_trimmed_previews_and_utf16_ranges() {
        let f = Fixture::new();
        f.write("src/app.ts", "const a = 1;\r\n    // héllo useState here\nuseState(useState)\n");
        let result = f.search("usestate", false, false, false);
        assert!(!result.truncated);
        assert_eq!(hits(&result), [("src/app.ts".to_owned(), 2), ("src/app.ts".to_owned(), 3)]);
        let first = &result.files[0].matches[0];
        assert_eq!(first.text, "// héllo useState here");
        assert_eq!(first.ranges, [[9, 17]]);
        assert_eq!(result.files[0].matches[1].ranges, [[0, 8], [9, 17]]);
    }

    #[test]
    fn match_case_whole_word_and_regex_toggles() {
        let f = Fixture::new();
        f.write("a.txt", "Token\ntoken\ntokens\n");
        assert_eq!(hits(&f.search("token", false, false, false)).len(), 3);
        assert_eq!(hits(&f.search("token", true, false, false)).iter().map(|h| h.1).collect::<Vec<_>>(), [2, 3]);
        assert_eq!(hits(&f.search("token", false, true, false)).iter().map(|h| h.1).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(hits(&f.search("tok.ns?$", false, false, true)).len(), 3);
        // Without regex mode the pattern is literal.
        assert!(hits(&f.search("tok.ns", false, false, false)).is_empty());
    }

    #[test]
    fn skips_ignored_excluded_binary_and_large_files() {
        let f = Fixture::new();
        f.write(".gitignore", "secret.txt\n");
        f.write("secret.txt", "needle");
        f.write("node_modules/pkg/index.js", "needle");
        f.write(".git/config", "needle");
        f.write("image.bin", b"needle\0\x01");
        f.write("big.txt", format!("needle{}", "x".repeat(MAX_FILE_BYTES as usize)));
        f.write(".env.example", "needle");
        f.write("keep.md", "needle");
        let found: Vec<_> = f.search("needle", false, false, false).files.into_iter().map(|f| f.path).collect();
        assert_eq!(found, [".env.example", "keep.md"]);
    }

    #[test]
    fn stops_at_the_match_limit() {
        let f = Fixture::new();
        f.write("many.txt", "x\n".repeat(MAX_MATCHES + 10));
        let result = f.search("x", false, false, false);
        assert!(result.truncated);
        assert_eq!(result.files[0].matches.len(), MAX_MATCHES);
    }

    #[test]
    fn long_lines_keep_context_before_the_match() {
        let f = Fixture::new();
        f.write("long.txt", format!("{}needle{}", "é".repeat(500), "z".repeat(500)));
        let m = &f.search("needle", false, false, false).files[0].matches[0];
        assert_eq!(m.ranges, [[CONTEXT_BEFORE, CONTEXT_BEFORE + 6]]);
        assert_eq!(m.text.chars().count(), PREVIEW_CHARS);
    }

    #[test]
    fn matches_inside_leading_whitespace_without_panicking() {
        let f = Fixture::new();
        f.write("indent.txt", "    foo\n   \n");
        let result = f.search(r"\s+", false, false, true);
        let lines: Vec<_> = result.files[0].matches.iter().map(|m| (m.line, m.text.as_str(), m.ranges.clone())).collect();
        assert_eq!(lines, [(1, "    foo", vec![[0, 4]]), (2, "   ", vec![[0, 3]])]);
        assert_eq!(f.search("  ", false, false, false).files[0].matches[0].ranges, [[0, 2], [2, 4]]);
    }

    #[test]
    fn whole_word_only_bounds_literal_edges_that_are_word_characters() {
        let f = Fixture::new();
        f.write("calls.ts", "call foo()\nfoo(); x@foo y\n");
        let lines = |query| hits(&f.search(query, false, true, false)).iter().map(|h| h.1).collect::<Vec<_>>();
        assert_eq!(lines("foo()"), [1, 2]);
        assert_eq!(lines("@foo"), [2]);
        assert!(lines("fo").is_empty());
    }

    #[test]
    fn one_long_line_cannot_exceed_the_match_limit() {
        let f = Fixture::new();
        f.write("minified.js", "a".repeat(MAX_MATCHES * 3));
        let result = f.search("a", false, false, false);
        assert!(result.truncated);
        assert_eq!(result.files[0].matches.len(), 1);
        assert_eq!(result.files[0].matches[0].ranges.len(), PREVIEW_CHARS);
    }

    #[test]
    fn rejects_invalid_queries() {
        let f = Fixture::new();
        assert!(search_text(&f.0, "", false, false, false).is_err());
        assert!(search_text(&f.0, "a\0b", false, false, false).is_err());
        let error = search_text(&f.0, "(unclosed", false, false, true).unwrap_err();
        assert!(error.starts_with("Invalid regular expression"), "{error}");
        // The same text is fine as a literal.
        assert!(search_text(&f.0, "(unclosed", false, false, false).is_ok());
    }

    #[test]
    fn read_inside_refuses_symlinks_and_outside_paths() {
        let f = Fixture::new();
        f.write("ok.txt", "hi");
        assert_eq!(read_inside(&f.0, &f.0.join("ok.txt"), false).unwrap(), b"hi");
        let other = Fixture::new();
        other.write("x.txt", "hi");
        assert!(read_inside(&f.0, &other.0.join("x.txt"), false).is_none());
        assert_eq!(read_inside_up_to(&f.0, &f.0.join("ok.txt"), 1, |_| false), None);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(other.0.join("x.txt"), f.0.join("link.txt")).unwrap();
            assert!(read_inside(&f.0, &f.0.join("link.txt"), false).is_none());
        }
    }

    /// A folder swapped for a symlink after the caller's checks is judged again by where the
    /// opened file really is.
    #[cfg(unix)]
    #[test]
    fn the_real_path_is_judged_after_opening() {
        let f = Fixture::new();
        f.write(".ssh/id", "key");
        f.write("docs/id", "doc");
        let root = f.0.canonicalize().unwrap();
        let refused = |path: &str| path.starts_with(".ssh");
        assert_eq!(read_inside_up_to(&root, &root.join("docs/id"), 10, refused).unwrap(), b"doc");
        std::fs::remove_dir_all(root.join("docs")).unwrap();
        std::os::unix::fs::symlink(root.join(".ssh"), root.join("docs")).unwrap();
        assert!(read_inside_up_to(&root, &root.join("docs/id"), 10, refused).is_none());
        assert!(open_inside_up_to(&root, &root.join("docs/id"), 10, refused).is_none());
        assert_eq!(read_inside(&root, &root.join("docs/id"), false).unwrap(), b"key", "no rule, no refusal");
    }

    /// The handle is judged, not the name: a folder renamed after opening moves the answer.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn the_handle_path_follows_the_open_file() {
        let f = Fixture::new();
        f.write("docs/id", "doc");
        let root = f.0.canonicalize().unwrap();
        let (file, _) = open_regular(&root.join("docs/id")).unwrap();
        assert_eq!(handle_path(&file, &root.join("docs/id")).unwrap(), root.join("docs/id"));
        std::fs::rename(root.join("docs"), root.join(".ssh")).unwrap();
        assert_eq!(handle_path(&file, &root.join("docs/id")).unwrap(), root.join(".ssh/id"));
    }

    #[test]
    fn results_are_ordered_by_path_without_a_sorted_walk() {
        let f = Fixture::new();
        for name in ["c.txt", "a/z.txt", "b.txt", "a/a.txt"] {
            f.write(name, "needle");
        }
        let paths: Vec<_> = f.search("needle", false, false, false).files.into_iter().map(|f| f.path).collect();
        assert_eq!(paths, ["a/a.txt", "a/z.txt", "b.txt", "c.txt"]);
    }

    #[test]
    fn a_file_over_the_limit_is_not_opened() {
        let f = Fixture::new();
        f.write("a.txt", "12345");
        let path = f.0.join("a.txt");
        assert!(open_inside_up_to(&f.0, &path, 5, |_| false).is_some_and(|(_, size)| size == 5));
        assert!(open_inside_up_to(&f.0, &path, 4, |_| false).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn opening_a_fifo_never_waits_for_a_writer() {
        let f = Fixture::new();
        let fifo = f.0.join("pipe");
        assert!(std::process::Command::new("mkfifo").arg(&fifo).status().unwrap().success());
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || sender.send(open_regular(&fifo).is_none()));
        assert_eq!(receiver.recv_timeout(std::time::Duration::from_secs(5)), Ok(true));
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinks_out_of_the_project() {
        let outside = Fixture::new();
        outside.write("outside.txt", "needle");
        let f = Fixture::new();
        std::os::unix::fs::symlink(&outside.0, f.0.join("link")).unwrap();
        assert!(f.search("needle", false, false, false).files.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn phone_searches_skip_hard_linked_files() {
        let outside = Fixture::new();
        outside.write("id_rsa", "needle secret");
        let f = Fixture::new();
        f.write("plain.txt", "needle");
        std::fs::hard_link(outside.0.join("id_rsa"), f.0.join("notes.txt")).unwrap();
        let paths = |result: TextSearchResult| result.files.into_iter().map(|file| file.path).collect::<Vec<_>>();
        assert_eq!(paths(search_text_for_phone(&f.0, "needle", false, false, false).unwrap()), ["plain.txt"], "the hard link is never read for a phone");
        assert_eq!(paths(f.search("needle", false, false, false)), ["notes.txt", "plain.txt"], "the desktop's search is unchanged");
        assert!(read_inside(&f.0, &f.0.join("notes.txt"), true).is_none());
    }
}
