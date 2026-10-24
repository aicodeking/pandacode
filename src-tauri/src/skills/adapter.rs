//! Per-harness adapters: the one place that knows where each harness reads skills and rules.
//! Skills become folders of files; rules become a marked block in the harness's instruction
//! file. Harnesses without a file surface get `Surface::Prompt`, which PandaCode injects.
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use super::{sha256_hex, Kind, Scope, Written};

/// Harnesses with file-based skills and instruction files.
pub const FILE_HARNESSES: &[&str] = &["claude", "codex"];
/// Every other PandaCode harness; their skills and rules ride in the prompt.
pub const PROMPT_HARNESSES: &[&str] = &["kimi", "opencode", "glm", "antigravity", "grok", "mimo", "pi", "deepseek", "commandcode", "cline", "kilo", "omp", "muse"];

pub enum Surface {
    /// A folder `<dir>/<id>/` holding the skill's files.
    Folder(PathBuf),
    /// A managed block inside this instruction file.
    Block(PathBuf),
    Prompt,
}

pub fn known(harness: &str) -> bool {
    FILE_HARNESSES.contains(&harness) || PROMPT_HARNESSES.contains(&harness)
}

/// Where `harness` reads a `kind` at `scope`. `base` is the home folder for user scope and
/// the checkout for project scope.
pub fn surface(harness: &str, kind: Kind, scope: Scope, base: &Path) -> Surface {
    let user = scope == Scope::User;
    match (harness, kind) {
        ("claude", Kind::Skill) => Surface::Folder(base.join(".claude/skills")),
        ("claude", Kind::Rule) => Surface::Block(if user { base.join(".claude/CLAUDE.md") } else { base.join("CLAUDE.md") }),
        ("codex", Kind::Skill) => Surface::Folder(base.join(".codex/skills")),
        ("codex", Kind::Rule) => Surface::Block(if user { base.join(".codex/AGENTS.md") } else { base.join("AGENTS.md") }),
        _ => Surface::Prompt,
    }
}

/// A harness counts as installed when its CLI is on the PATH or its home folder exists.
pub fn installed(harness: &str, home: &Path) -> bool {
    home.join(format!(".{harness}")).is_dir() || crate::token_saver::find_tool(harness).is_some()
}

fn begin(id: &str) -> String {
    format!("<!-- pandacode:rule:{id} -->")
}
fn end(id: &str) -> String {
    format!("<!-- /pandacode:rule:{id} -->")
}

/// The body of `id`'s managed block in `text`, and the byte range of the whole block.
pub fn block(text: &str, id: &str) -> Option<(String, std::ops::Range<usize>)> {
    let (open, close) = (begin(id), end(id));
    let start = text.find(&open)?;
    let body_start = start + open.len();
    let body_end = body_start + text[body_start..].find(&close)?;
    let mut stop = body_end + close.len();
    if text[stop..].starts_with('\n') {
        stop += 1;
    }
    Some((text[body_start..body_end].trim_matches('\n').to_string(), start..stop))
}

/// Ids of every managed block in `text`, and whether anything outside them has content.
pub fn blocks_in(text: &str) -> (Vec<String>, bool) {
    let mut ids = Vec::new();
    let mut rest = text.to_string();
    while let Some(at) = rest.find("<!-- pandacode:rule:") {
        let tail = &rest[at + "<!-- pandacode:rule:".len()..];
        let Some(id) = tail.split(" -->").next().map(str::to_string) else { break };
        let Some((_, range)) = block(&rest, &id) else { break };
        rest.replace_range(range, "");
        ids.push(id);
    }
    (ids, !rest.trim().is_empty())
}

/// Write `files` as `<dir>/<id>/…`. Refuses a folder PandaCode did not create, and files
/// edited since PandaCode wrote them (`previous` is what it wrote last time).
pub fn write_folder(dir: &Path, id: &str, files: &[(String, Vec<u8>)], previous: &[Written]) -> Result<Vec<Written>, String> {
    let target = dir.join(id);
    if target.exists() && previous.is_empty() {
        return Err(format!("{} already exists and PandaCode did not create it.", target.display()));
    }
    for written in previous {
        let path = Path::new(&written.path);
        if path.exists() && file_hash(path).as_deref() != Some(written.sha256.as_str()) {
            return Err(format!("{} was edited on disk; PandaCode will not overwrite it.", written.path));
        }
    }
    for written in previous {
        let _ = fs::remove_file(&written.path);
    }
    let mut out = Vec::new();
    for (relative, bytes) in files {
        let path = target.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
        }
        fs::write(&path, bytes).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
        out.push(Written { path: path.to_string_lossy().into_owned(), sha256: sha256_hex(bytes) });
    }
    Ok(out)
}

/// Remove the files PandaCode wrote that still match; returns the ones left because they changed.
pub fn remove_folder(written: &[Written]) -> Vec<String> {
    let mut kept = Vec::new();
    for file in written {
        let path = Path::new(&file.path);
        match file_hash(path) {
            Some(hash) if hash == file.sha256 => { let _ = fs::remove_file(path); }
            Some(_) => kept.push(file.path.clone()),
            None => {}
        }
        // Empty folders left behind go too, up to the skill's own folder.
        let mut parent = path.parent();
        while let Some(dir) = parent {
            if fs::remove_dir(dir).is_err() { break }
            parent = dir.parent();
            if parent.is_some_and(|p| p.file_name().is_some_and(|n| n == "skills")) { break }
        }
    }
    kept
}

/// Add or update `id`'s block in `file`, leaving everything else in the file alone.
pub fn write_block(file: &Path, id: &str, body: &str, previous: Option<&Written>) -> Result<Written, String> {
    let text = fs::read_to_string(file).unwrap_or_default();
    let block_text = format!("{}\n{}\n{}\n", begin(id), body.trim_matches('\n'), end(id));
    let next = match block(&text, id) {
        Some((current, range)) => {
            if previous.is_none_or(|p| sha256_hex(current.as_bytes()) != p.sha256) {
                return Err(format!("The {id} block in {} was edited on disk; PandaCode will not overwrite it.", file.display()));
            }
            let mut next = text.clone();
            next.replace_range(range, &block_text);
            next
        }
        None if text.trim().is_empty() => block_text,
        None => format!("{}\n\n{block_text}", text.trim_end()),
    };
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    fs::write(file, next).map_err(|e| format!("Could not write {}: {e}", file.display()))?;
    Ok(Written { path: file.to_string_lossy().into_owned(), sha256: sha256_hex(body.trim_matches('\n').as_bytes()) })
}

/// Remove `id`'s block when it still matches; Ok(false) when it was edited and was left.
pub fn remove_block(written: &Written, id: &str) -> Result<bool, String> {
    let file = Path::new(&written.path);
    let Ok(text) = fs::read_to_string(file) else { return Ok(true) };
    let Some((current, range)) = block(&text, id) else { return Ok(true) };
    if sha256_hex(current.as_bytes()) != written.sha256 {
        return Ok(false);
    }
    let mut next = text;
    next.replace_range(range, "");
    if next.trim().is_empty() {
        fs::remove_file(file).map_err(|e| format!("Could not remove {}: {e}", file.display()))?;
    } else {
        fs::write(file, format!("{}\n", next.trim_end())).map_err(|e| format!("Could not write {}: {e}", file.display()))?;
    }
    Ok(true)
}

pub fn file_hash(path: &Path) -> Option<String> {
    fs::read(path).ok().map(|bytes| sha256_hex(&bytes))
}

/// The checkout's `info/exclude`, or None outside Git.
fn exclude_file(root: &Path) -> Option<PathBuf> {
    let mut command = Command::new("git");
    command.current_dir(root).args(["rev-parse", "--git-path", "info/exclude"]);
    let output = crate::workspace::checked(crate::workspace::run_process(command, "git", 4096, Duration::from_secs(10)).ok()?).ok()?;
    let path = PathBuf::from(String::from_utf8_lossy(&output.bytes).trim());
    Some(if path.is_absolute() { path } else { root.join(path) })
}

/// The exclude line for `path` inside `root` (`/CLAUDE.md`, `/.claude/skills/x/`).
pub fn exclude_entry(root: &Path, path: &Path, folder: bool) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
    Some(format!("/{relative}{}", if folder { "/" } else { "" }))
}

/// Add `entry` to the checkout's exclude list; returns whether this call added it.
pub fn exclude(root: &Path, entry: &str) -> Result<bool, String> {
    let Some(file) = exclude_file(root) else { return Ok(false) };
    let text = fs::read_to_string(&file).unwrap_or_default();
    if text.lines().any(|line| line.trim() == entry) {
        return Ok(false);
    }
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let separator = if text.is_empty() || text.ends_with('\n') { "" } else { "\n" };
    fs::write(&file, format!("{text}{separator}{entry}\n")).map_err(|e| format!("Could not update {}: {e}", file.display()))?;
    Ok(true)
}

pub fn unexclude(root: &Path, entry: &str) {
    let Some(file) = exclude_file(root) else { return };
    let Ok(text) = fs::read_to_string(&file) else { return };
    let kept: Vec<&str> = text.lines().filter(|line| line.trim() != entry).collect();
    let _ = fs::write(&file, if kept.is_empty() { String::new() } else { format!("{}\n", kept.join("\n")) });
}

/// Skill folders under `dir` that hold a SKILL.md.
pub fn skill_folders(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut found: Vec<_> = entries
        .flatten()
        .filter(|entry| entry.path().join("SKILL.md").is_file())
        .map(|entry| (entry.file_name().to_string_lossy().into_owned(), entry.path()))
        .collect();
    found.sort();
    found
}
