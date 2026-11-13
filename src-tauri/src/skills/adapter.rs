//! Per-harness adapters: the one place that knows where each harness reads skills and rules.
//! Skills become folders of files; rules become a marked block in the harness's instruction
//! file. Harnesses without a file surface get `Surface::Prompt`, which PandaCode injects.
use std::{
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
    time::Duration,
};

use super::{sha256_hex, Kind, Scope, Written};

/// The largest rule file or written skill file PandaCode reads back: twice a library item's
/// size, so a rule file with the user's own instructions around a block still fits (Round 24).
pub const READ_LIMIT: u64 = 2 * super::MAX_BYTES as u64;

/// A rule or skill file's text, bounded and only from a regular file (a symlink to one is
/// followed; one to `/dev/zero` or a FIFO is refused), so a project file can never run the host
/// out of memory or block it (Round 24). A missing file is `NotFound`; anything else that is
/// not a regular UTF-8 file of at most [`READ_LIMIT`] is content PandaCode does not manage.
pub fn read_text(path: &Path) -> std::io::Result<String> {
    let bytes = crate::workspace::read_regular_target(path, READ_LIMIT)?;
    String::from_utf8(bytes).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// Harnesses with file-based skills and instruction files.
pub const FILE_HARNESSES: &[&str] = &["claude", "codex"];
/// Every other PandaCode harness; their skills and rules ride in the prompt.
pub const PROMPT_HARNESSES: &[&str] = &["kimi", "opencode", "glm", "antigravity", "grok", "mimo", "alibaba", "pi", "deepseek", "commandcode", "cline", "kilo", "omp", "muse", "devin", "zcode", "hermes"];

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
        // Codex reads repository skills from `.agents/skills` (the CWD up to the repo root), not
        // `.codex/skills`; `capabilities::skill_roots` already lists that folder for a project.
        ("codex", Kind::Skill) => Surface::Folder(if user { base.join(".codex/skills") } else { base.join(".agents/skills") }),
        ("codex", Kind::Rule) => Surface::Block(if user { base.join(".codex/AGENTS.md") } else { base.join("AGENTS.md") }),
        _ => Surface::Prompt,
    }
}

/// What `id`'s activation for `harness` at `scope` writes in `base`, with whether it is a
/// folder: the skill's own folder `<surface>/<id>` (plus the old Codex `.codex/skills/<id>` in a
/// project), or the rule file.
pub fn targets(harness: &str, kind: Kind, scope: Scope, base: &Path, id: &str) -> Vec<(PathBuf, bool)> {
    match surface(harness, kind, scope, base) {
        Surface::Folder(dir) if harness == "codex" && scope == Scope::Project => vec![(dir.join(id), true), (base.join(".codex/skills").join(id), true)],
        Surface::Folder(dir) => vec![(dir.join(id), true)],
        Surface::Block(file) => vec![(file, false)],
        Surface::Prompt => Vec::new(),
    }
}

/// Whether `path`, recorded in `id`'s activation for `harness` at `scope` (in `base`), is a
/// place that activation writes: exactly the rule file for a rule, or a file below the skill's
/// own folder (`<surface>/<id>/…`, plus the old Codex `.codex/skills/<id>/` in a project).
/// Compared component by component; the part below the folder may hold only plain names, so
/// `<surface>/<id>/../../victim` is refused. A tampered library record never reaches a file
/// PandaCode would not write itself.
pub fn recorded_in_surface(harness: &str, kind: Kind, scope: Scope, base: &Path, id: &str, path: &Path) -> bool {
    let below = |dir: PathBuf| {
        path.strip_prefix(dir.join(id)).is_ok_and(|rest| rest.components().next().is_some() && rest.components().all(|c| matches!(c, Component::Normal(_))))
    };
    let plain = path.components().all(|c| !matches!(c, Component::ParentDir | Component::CurDir));
    plain
        && match surface(harness, kind, scope, base) {
            Surface::Folder(dir) => below(dir) || (harness == "codex" && scope == Scope::Project && below(base.join(".codex/skills"))),
            Surface::Block(file) => path == file,
            Surface::Prompt => false,
        }
}

/// Whether a recorded project folder is one PandaCode could have worked in: absolute,
/// normalised (no `.` or `..`), and neither a filesystem root nor the home folder itself.
pub fn plain_project(project: &Path, home: &Path) -> bool {
    project.is_absolute()
        && project.parent().is_some()
        && project != home
        && project.components().all(|c| matches!(c, Component::Prefix(_) | Component::RootDir | Component::Normal(_)))
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
/// edited since PandaCode wrote them (`previous` is what it wrote last time). `project` is the
/// checkout root in project scope, where no link leading outside it is written through.
/// Every file is checked ([`check_folder`]) before anything is removed or written. A file
/// this call creates is created exclusively (a failed one is removed again); one replacing
/// the previous version is, in project scope, replaced whole, so a failed write leaves the
/// old file. A write that still fails partway removes every file this call created, recorded
/// path or not (previous ones no longer part of the item stay gone; ones it replaced keep the
/// new version, for the caller to put back) and returns, with the error, those it had to leave
/// (edited, or behind a link) and the path it was writing when it failed (None when the checks
/// refused it): in user scope that file is rewritten in place, so it may be half written.
pub fn write_folder(dir: &Path, id: &str, files: &[(String, Vec<u8>)], previous: &[Written], project: Option<&Path>) -> Result<Vec<Written>, FolderError> {
    check_folder(dir, id, files, previous, project).map_err(|e| (e, Vec::new(), None))?;
    let target = dir.join(id);
    // Checked again just before each removal: a link swapped in since stays, like on remove.
    let real_root = project.map(|root| (root, fs::canonicalize(root).ok()));
    let rewritten = |path: &Path| files.iter().any(|(relative, _)| target.join(relative) == path);
    for written in previous {
        let path = Path::new(&written.path);
        if rewritten(path) {
            continue;
        }
        if real_root.as_ref().is_none_or(|(root, real)| outside_link(root, real.as_deref(), path, Links::Skills).is_none()) {
            // Folders it leaves empty go too, so deactivate can remove the skill's folder.
            if fs::remove_file(path).is_ok() {
                remove_empty(path, &target);
            }
        }
    }
    let mut out: Vec<Written> = Vec::new();
    // What this call created (nothing was at the path before its write), for a failed write to take back.
    let mut created: Vec<Written> = Vec::new();
    for (relative, bytes) in files {
        let path = target.join(relative);
        let replaced = previous.iter().any(|w| Path::new(&w.path) == path) && fs::symlink_metadata(&path).is_ok();
        let wrote = path
            .parent()
            .map_or(Ok(()), |parent| {
                // Checked again right before the folders are made: a link swapped in along the
                // chain since `check_folder` is refused (a narrow race remains until the open).
                if let Some(root) = project {
                    parent_inside(root, parent)?;
                }
                fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))
            })
            .and_then(|()| write_file_as(&path, bytes, project, Links::Skills, !replaced));
        if let Err(e) = wrote {
            // Only files this call created that still hold what it wrote go, with folders left
            // empty (a recorded file the user had deleted too); one it replaced is left for the
            // caller to put back.
            let left = remove_folder(&created, std::slice::from_ref(&target), project);
            remove_empty(&path, &target);
            return Err((e, left, Some(path)));
        }
        let written = Written { path: path.to_string_lossy().into_owned(), sha256: sha256_hex(bytes) };
        if !replaced {
            created.push(written.clone());
        }
        out.push(written);
    }
    Ok(out)
}

/// A failed [`write_folder`]: the error, the files it had to leave, and the path it was writing.
pub type FolderError = (String, Vec<String>, Option<PathBuf>);

/// The read-only checks [`write_folder`] makes before it removes or writes anything, so a
/// caller can run them before changing anything else (the Git exclude list).
pub fn check_folder(dir: &Path, id: &str, files: &[(String, Vec<u8>)], previous: &[Written], project: Option<&Path>) -> Result<(), String> {
    let target = dir.join(id);
    if let Some(root) = project {
        refuse_outside_links(root, &target, Links::Skills)?;
        for written in previous {
            refuse_outside_links(root, Path::new(&written.path), Links::Skills)?;
        }
        let real_root = fs::canonicalize(root).ok();
        for (relative, _) in files {
            let path = target.join(relative);
            refuse_outside_links(root, &path, Links::Skills)?;
            // The same resolved-target rule `write_file` applies, for folders not created yet.
            if let Some(real_root) = &real_root {
                if !real_location(&path).is_some_and(|real| inside_project(real_root, &real, Links::Skills)) {
                    return Err(link_refused(&path));
                }
            }
            // The hard-link rule `write_file` applies on the open, previous files included (they
            // are replaced, not removed first).
            if fs::metadata(&path).is_ok_and(|meta| hard_linked_meta(&meta)) {
                return Err(hard_link_refused(&path));
            }
        }
    }
    // A FIFO or device at a file's path would block the write (holding the library lock).
    if let Some(path) = files.iter().map(|(relative, _)| target.join(relative)).find(|path| fs::metadata(path).is_ok_and(|meta| !meta.is_file())) {
        return Err(not_regular(&path));
    }
    if target.exists() && previous.is_empty() {
        return Err(format!("{} already exists and PandaCode did not create it.", target.display()));
    }
    // A file the new version adds where the user put their own would fail its exclusive create
    // halfway through the write; refused here, before anything changes. A recorded file under
    // another name counts as recorded (`README.md` for `Readme.md` on a case-insensitive disk).
    let recorded = |path: &Path| previous.iter().any(|w| Path::new(&w.path) == path || same_file(Path::new(&w.path), path));
    if let Some(path) = files.iter().map(|(relative, _)| target.join(relative)).find(|path| fs::symlink_metadata(path).is_ok() && !recorded(path)) {
        return Err(format!("{} already exists and PandaCode did not write it; move it away and try again.", path.display()));
    }
    for written in previous {
        let path = Path::new(&written.path);
        if path.exists() && file_hash(path).as_deref() != Some(written.sha256.as_str()) {
            return Err(format!("{} was edited on disk; PandaCode will not overwrite it.", written.path));
        }
    }
    Ok(())
}

/// The link rules for a skill folder `dir` about to be created in the project at `root`: no link
/// along it leads outside, and where it really lands is inside the project's skills folders.
fn parent_inside(root: &Path, dir: &Path) -> Result<(), String> {
    refuse_outside_links(root, dir, Links::Skills)?;
    match fs::canonicalize(root) {
        Ok(real_root) if !real_location(dir).is_some_and(|real| inside_project(&real_root, &real, Links::Skills)) => Err(link_refused(dir)),
        _ => Ok(()),
    }
}

/// Whether `a` and `b` name the same file, as two spellings of one name do on a
/// case-insensitive disk: the same device and inode on unix, elsewhere the same canonical path
/// ignoring case.
pub(super) fn same_file(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        matches!((fs::symlink_metadata(a), fs::symlink_metadata(b)), (Ok(x), Ok(y)) if x.dev() == y.dev() && x.ino() == y.ino())
    }
    #[cfg(not(unix))]
    {
        matches!((fs::canonicalize(a), fs::canonicalize(b)), (Ok(x), Ok(y)) if x.to_string_lossy().to_lowercase() == y.to_string_lossy().to_lowercase())
    }
}

fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
}

fn link_refused(path: &Path) -> String {
    format!("{} is a link; PandaCode does not write through links.", path.display())
}

/// Project-scope writes never follow a link out of the project: a project's CLAUDE.md linked
/// to a file elsewhere (or a planted `.claude` link) must not let activation change that file.
/// A link whose fully resolved target stays inside the project is fine when it leads to a
/// rule file for a rule (`AGENTS.md -> CLAUDE.md`) or into a skills folder for a skill
/// (`.agents/skills -> ../.claude/skills`), never into the Git directory (`CLAUDE.md ->
/// .git/config` or a hook) or another file (`AGENTS.md -> Makefile`); a broken one is refused. When the project root
/// itself cannot be resolved (some Windows virtual drives), every link along the path is
/// refused instead. User scope still writes through links (dotfiles setups link
/// `~/.claude/CLAUDE.md`); reads always follow them.
fn refuse_outside_links(root: &Path, path: &Path, links: Links) -> Result<(), String> {
    match outside_link(root, fs::canonicalize(root).ok().as_deref(), path, links) {
        Some(link) => Err(link_refused(&link)),
        None => Ok(()),
    }
}

/// What a project-scope write may follow an in-project link to, so a cloned repository's
/// `AGENTS.md -> Makefile` (or `-> .github/workflows/ci.yml`) never gets a rule appended.
#[derive(Clone, Copy)]
pub(super) enum Links {
    /// Rule blocks: only to another rule file (`AGENTS.md -> CLAUDE.md`).
    Rule,
    /// Skill folders: only into a skills folder (`.agents/skills -> ../.claude/skills`).
    Skills,
    /// The Git exclude list, written with the Git folder as the root.
    Git,
}

/// The instruction files [`surface`] writes rule blocks into.
const RULE_FILES: &[&str] = &["CLAUDE.md", "AGENTS.md"];
/// The project skills folders [`surface`] writes into, plus the old Codex one moves remove from.
const SKILL_FOLDERS: &[&str] = &[".claude/skills", ".agents/skills", ".codex/skills"];

/// Whether the canonical path `real` is inside the canonical project root, not in its Git
/// directory, and a place a `links` write may land.
fn inside_project(real_root: &Path, real: &Path, links: Links) -> bool {
    real.strip_prefix(real_root).is_ok_and(|inside| !inside.components().any(|c| c.as_os_str() == ".git"))
        && match links {
            Links::Rule => real.file_name().is_some_and(|name| RULE_FILES.iter().any(|rule| name == *rule)),
            Links::Skills => SKILL_FOLDERS.iter().any(|dir| real.starts_with(real_root.join(dir))),
            Links::Git => true,
        }
}

/// The first link along `path` (below `root`) that leads out of the project, into its Git
/// directory, or nowhere (any link at all when `real_root` is unknown); a path outside `root`
/// is returned whole.
pub(super) fn outside_link(root: &Path, real_root: Option<&Path>, path: &Path, links: Links) -> Option<PathBuf> {
    let Ok(relative) = path.strip_prefix(root) else { return Some(path.to_path_buf()) };
    let mut at = root.to_path_buf();
    for part in relative.components() {
        at.push(part);
        if is_link(&at) && !real_root.is_some_and(|real_root| fs::canonicalize(&at).is_ok_and(|real| inside_project(real_root, &real, links))) {
            return Some(at);
        }
    }
    None
}

/// The path a project-scope write opens for `path`: a link's canonical target, otherwise the
/// canonical parent folder joined with the file name. None unless that resolved path is
/// inside the project and outside its Git directory, the same rule as [`outside_link`].
pub(super) fn resolved_target(real_root: &Path, path: &Path, links: Links) -> Option<PathBuf> {
    let real = if is_link(path) {
        fs::canonicalize(path).ok()?
    } else {
        fs::canonicalize(path.parent()?).ok()?.join(path.file_name()?)
    };
    inside_project(real_root, &real, links).then_some(real)
}

/// Write `bytes` to `path`. In project scope the links along it are checked, then the path is
/// resolved and the resolved path checked again by the same rule, and the file opened there
/// without following a link in its last component. So a link swapped in for any component
/// before the resolve, or for the file itself before the open, is refused; a parent folder
/// swapped for a link between the resolve and the open is still followed (a narrow race).
fn write_file(path: &Path, bytes: &[u8], project: Option<&Path>, links: Links) -> Result<(), String> {
    write_file_as(path, bytes, project, links, false)
}

/// [`write_file`]; with `new` the file must not exist yet (it is created exclusively), and a
/// write that then fails removes it again ([`discard_created`]).
fn write_file_as(path: &Path, bytes: &[u8], project: Option<&Path>, links: Links, new: bool) -> Result<(), String> {
    use std::io::Write;
    let failed = |e: std::io::Error| format!("Could not write {}: {e}", path.display());
    let target = match project {
        // User scope rewrites in place, through links (dotfiles setups), as `fs::write` does.
        // Opened without blocking (a FIFO there never stalls the library lock) and without
        // truncating, so anything but a regular file is refused before a byte changes.
        None if !new => {
            let mut options = fs::OpenOptions::new();
            options.write(true).create(true).truncate(false);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NONBLOCK);
            }
            let mut file = options.open(path).map_err(failed)?;
            if !file.metadata().is_ok_and(|meta| meta.is_file()) {
                return Err(not_regular(path));
            }
            return file.set_len(0).and_then(|()| fail_point::before_write(path, &mut file, bytes)).and_then(|()| file.write_all(bytes)).map_err(failed);
        }
        None => path.to_path_buf(),
        Some(root) => {
            let real_root = fs::canonicalize(root).ok();
            if let Some(link) = outside_link(root, real_root.as_deref(), path, links) {
                return Err(link_refused(&link));
            }
            match real_root {
                Some(real_root) => resolved_target(&real_root, path, links).ok_or_else(|| link_refused(path))?,
                // No link anywhere along the path (checked above); the open refuses one swapped in.
                None => path.to_path_buf(),
            }
        }
    };
    let mut file = create_no_follow(&target, new).map_err(failed)?;
    if !file.metadata().is_ok_and(|meta| meta.is_file()) {
        return Err(not_regular(path));
    }
    // Checked on the open file, before truncating: a hard link is another name for a file
    // that may live anywhere, so rewriting it in place would change that file too.
    if file.metadata().is_ok_and(|meta| hard_linked_meta(&meta)) {
        return Err(hard_link_refused(path));
    }
    // An existing project file (a rule file with the user's own text around the block, the Git
    // exclude list, a skill file's previous version) is replaced whole (a temporary file renamed
    // over it, in the resolved target's folder) so a failed write never leaves it truncated or
    // half written. The checks above ran on the opened file.
    if project.is_some() && !new {
        let permissions = file.metadata().map_err(failed)?.permissions();
        drop(file);
        return replace_file(&target, bytes, permissions).map_err(failed);
    }
    file.set_len(0).and_then(|()| fail_point::before_write(path, &mut file, bytes)).and_then(|()| file.write_all(bytes)).map_err(|e| {
        if new {
            discard_created(&target, &file, bytes);
        }
        failed(e)
    })
}

/// Writes `bytes` to a new temporary file beside `target` (created exclusively, never through
/// a link), with `permissions`, synced, then renamed over `target`; the temporary file is
/// removed on any failure, leaving `target` as it was.
fn replace_file(target: &Path, bytes: &[u8], permissions: fs::Permissions) -> std::io::Result<()> {
    use std::io::Write;
    let (Some(dir), Some(name)) = (target.parent(), target.file_name()) else { return Err(std::io::Error::other("no parent folder")) };
    let temp = dir.join(format!(".{}.pandacode-{}.tmp", name.to_string_lossy(), uuid::Uuid::new_v4()));
    let mut file = create_no_follow(&temp, true)?;
    let written = file
        .write_all(bytes)
        .and_then(|()| file.set_permissions(permissions))
        .and_then(|()| file.sync_all())
        .and_then(|()| fs::rename(&temp, target));
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

/// Removes the file at `path` that `file` created exclusively and failed to fill: only while
/// `path` still names that same file, no other name links to it, and it holds nothing but a
/// start of `attempted` (empty, or a partial write). Anything else is someone else's now and
/// stays. Elsewhere than unix the identity can't be compared, so a regular file of the same
/// length as the open one, holding only a start of `attempted`, counts as the same file.
pub(super) fn discard_created(path: &Path, file: &fs::File, attempted: &[u8]) {
    let (Ok(ours), Ok(there)) = (file.metadata(), fs::symlink_metadata(path)) else { return };
    #[cfg(unix)]
    let same = {
        use std::os::unix::fs::MetadataExt as _;
        there.dev() == ours.dev() && there.ino() == ours.ino() && there.nlink() == 1
    };
    #[cfg(not(unix))]
    let same = there.len() == ours.len();
    let ours_only = there.is_file() && there.len() <= attempted.len() as u64 && fs::read(path).is_ok_and(|held| attempted.starts_with(&held));
    // ponytail: a rename over `path` between this check and the removal is not caught.
    if same && ours_only {
        let _ = fs::remove_file(path);
    }
}

fn not_regular(path: &Path) -> String {
    format!("{} is not a regular file; PandaCode will not write to it.", path.display())
}

fn hard_link_refused(path: &Path) -> String {
    format!("{} is hard-linked elsewhere; PandaCode does not write through hard links.", path.display())
}

fn hard_linked_meta(meta: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        meta.is_file() && meta.nlink() > 1
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        false
    }
}

/// Opens `path` for writing without truncating (the caller truncates once it has checked the
/// file) and, on unix, without following a link in its last component; with `new` only when
/// this call creates it. On unix the open never blocks (a FIFO planted at `path`); the caller
/// refuses anything but a regular file before writing.
fn create_no_follow(path: &Path, new: bool) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(false).create_new(new);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(not(unix))]
    if is_link(path) {
        return Err(std::io::Error::other("is a link"));
    }
    options.open(path)
}

/// Remove the files PandaCode wrote that still match; returns the ones left because they
/// changed or, in project scope, sit behind a link leading out of the project. Folders left
/// empty go too, up to and including the skill's own folder among `folders` that holds the file.
pub fn remove_folder(written: &[Written], folders: &[PathBuf], project: Option<&Path>) -> Vec<String> {
    let mut kept = Vec::new();
    // A project folder that is gone (deleted or moved) has no links left along it, so its
    // files count as removed; one that cannot be resolved keeps files behind any link.
    let real_root = project.map(|root| (root, fs::canonicalize(root).ok()));
    for file in written {
        let path = Path::new(&file.path);
        if real_root.as_ref().is_some_and(|(root, real)| outside_link(root, real.as_deref(), path, Links::Skills).is_some()) {
            kept.push(file.path.clone());
            continue;
        }
        match file_hash(path) {
            Some(hash) if hash == file.sha256 => { let _ = fs::remove_file(path); }
            Some(_) => kept.push(file.path.clone()),
            None => {}
        }
        if let Some(folder) = folders.iter().find(|folder| path.starts_with(folder)) {
            remove_empty(path, folder);
        }
    }
    kept
}

/// Removes the empty folders above `path`, up to and including `folder`.
fn remove_empty(path: &Path, folder: &Path) {
    let mut dir = path.parent();
    while let Some(empty) = dir.filter(|d| d.starts_with(folder) && fs::remove_dir(d).is_ok()) {
        dir = empty.parent();
    }
}

/// Add or update `id`'s block in `file`, leaving everything else in the file alone.
pub fn write_block(file: &Path, id: &str, body: &str, previous: Option<&Written>, project: Option<&Path>) -> Result<Written, String> {
    let next = block_update(file, id, body, previous, project)?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    // A file this call creates is created exclusively, so a failed write can remove it.
    let new = fs::symlink_metadata(file).is_err();
    write_file_as(file, next.as_bytes(), project, Links::Rule, new)?;
    Ok(Written { path: file.to_string_lossy().into_owned(), sha256: sha256_hex(body.trim_matches('\n').as_bytes()) })
}

/// The read-only checks [`write_block`] makes before it writes, so a caller can run them
/// before changing anything else (the Git exclude list).
pub fn check_block(file: &Path, id: &str, previous: Option<&Written>, project: Option<&Path>) -> Result<(), String> {
    block_update(file, id, "", previous, project).map(drop)
}

/// The checked new text of `file` with `id`'s block set to `body`.
fn block_update(file: &Path, id: &str, body: &str, previous: Option<&Written>, project: Option<&Path>) -> Result<String, String> {
    if let Some(root) = project {
        refuse_outside_links(root, file, Links::Rule)?;
        // The resolved-target and hard-link rules `write_file` applies on the open.
        if fs::canonicalize(root).ok().is_some_and(|real_root| resolved_target(&real_root, file, Links::Rule).is_none()) {
            return Err(link_refused(file));
        }
        if fs::metadata(file).is_ok_and(|meta| hard_linked_meta(&meta)) {
            return Err(hard_link_refused(file));
        }
    }
    let text = match read_text(file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return Err(format!("{} is not a text file PandaCode can add to.", file.display())),
    };
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
    Ok(next)
}

/// Remove `id`'s block when it still matches; Ok(false) when it was edited and was left.
pub fn remove_block(written: &Written, id: &str, project: Option<&Path>) -> Result<bool, String> {
    let file = Path::new(&written.path);
    let text = match read_text(file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        // Not a regular text file any more: left as it is, like an edited block.
        Err(_) => return Ok(false),
    };
    if project.is_some_and(|root| refuse_outside_links(root, file, Links::Rule).is_err()) {
        // Turned into a link out of the project since PandaCode wrote it: left as it is.
        return Ok(false);
    }
    let Some((current, range)) = block(&text, id) else { return Ok(true) };
    if sha256_hex(current.as_bytes()) != written.sha256 {
        return Ok(false);
    }
    let mut next = text;
    next.replace_range(range, "");
    if !next.trim().is_empty() {
        write_file(file, format!("{}\n", next.trim_end()).as_bytes(), project, Links::Rule)?;
    } else if is_link(file) {
        // Removing a link would leave the block in its target; empty the target instead.
        write_file(file, b"", project, Links::Rule)?;
    } else {
        fs::remove_file(file).map_err(|e| format!("Could not remove {}: {e}", file.display()))?;
    }
    Ok(true)
}

/// The hash of a file PandaCode wrote; None when it is missing or no longer a bounded regular file.
pub fn file_hash(path: &Path) -> Option<String> {
    crate::workspace::read_regular_target(path, READ_LIMIT).ok().map(|bytes| sha256_hex(&bytes))
}

/// What `git rev-parse <flag>` prints for the checkout at `root`, or None outside Git.
fn git_output(root: &Path, flag: &str) -> Option<String> {
    let mut command = Command::new("git");
    command.current_dir(root).args(["rev-parse", flag]);
    let output = crate::workspace::run_process(command, "git", 4096, Duration::from_secs(10)).ok().and_then(|o| crate::workspace::checked(o).ok())?;
    Some(String::from_utf8_lossy(&output.bytes).trim().to_string())
}

/// The path `git rev-parse <flag>` prints for the checkout at `root` (made absolute, not
/// resolved), or None outside Git.
fn git_path(root: &Path, flag: &str) -> Option<PathBuf> {
    git_output(root, flag).map(|printed| root.join(printed))
}

/// `path` canonical, or as given when it cannot be resolved (some Windows virtual drives).
fn canonical_or_same(path: PathBuf) -> PathBuf {
    fs::canonicalize(&path).unwrap_or(path)
}

/// The checkout's shared Git folder, only when it is really this checkout's: the repository's
/// own `<top level>/.git` (a real folder, not a link to another repository's), or the main repository of a genuine linked worktree, where the top
/// level holds `root` and is where Git found the repository ([`found_at_top`]). A planted `.git`
/// file (`gitdir: /elsewhere/.git`, or a `core.worktree` of `/`) in a folder that is not a clone
/// would otherwise point the exclude update at another repository.
fn trusted_git_dir(root: &Path) -> Option<PathBuf> {
    let top = canonical_or_same(git_path(root, "--show-toplevel")?);
    let common = canonical_or_same(git_path(root, "--git-common-dir")?);
    let dot_git = top.join(".git");
    let real_dir = fs::symlink_metadata(&dot_git).is_ok_and(|meta| meta.is_dir());
    let own = (real_dir && canonical_or_same(dot_git) == common) || linked_worktree(&top, &common);
    (own && found_at_top(&canonical_or_same(root.to_path_buf()), &top)).then_some(common)
}

/// Whether the `.git` nearest `root` (where Git starts looking) is the top level's own. A top
/// level above a `.git` that sits deeper, inside the project, was moved up by `core.worktree`.
pub(super) fn found_at_top(root: &Path, top: &Path) -> bool {
    root.starts_with(top) && root.ancestors().find(|dir| fs::symlink_metadata(dir.join(".git")).is_ok()) == Some(top)
}

/// Whether `top/.git` is a file (not a link) naming `<common>/worktrees/<name>`, whose own `gitdir` file
/// names `top/.git` back: what `git worktree add` sets up, and a planted file cannot fake.
fn linked_worktree(top: &Path, common: &Path) -> bool {
    let dot_git = top.join(".git");
    if !fs::symlink_metadata(&dot_git).is_ok_and(|meta| meta.is_file()) {
        return false;
    }
    let named = |file: &Path, from: &Path| -> Option<PathBuf> {
        let text = read_text(file).ok()?;
        let named = text.trim().strip_prefix("gitdir:").unwrap_or(text.trim()).trim().to_string();
        fs::canonicalize(from.join(named)).ok()
    };
    let Some(worktree) = named(&dot_git, top) else { return false };
    if worktree.parent() != Some(common.join("worktrees").as_path()) {
        return false;
    }
    let back = named(&worktree.join("gitdir"), &worktree);
    back.is_some() && back == fs::canonicalize(&dot_git).ok()
}

/// The checkout's `info/exclude` and its Git folder, or None outside Git or when the Git
/// folder is not this checkout's ([`trusted_git_dir`]). The file is built under the canonical
/// Git folder and refused when it or `info` is a link, so an exclude update never writes
/// outside the project's Git folder.
fn exclude_file(root: &Path) -> Result<Option<(PathBuf, PathBuf)>, String> {
    let Some(git_dir) = trusted_git_dir(root) else { return Ok(None) };
    let info = git_dir.join("info");
    let file = info.join("exclude");
    if let Some(link) = [&info, &file].into_iter().find(|path| is_link(path)) {
        return Err(format!("{} is a link; PandaCode does not update the Git exclude list through links.", link.display()));
    }
    Ok(Some((file, git_dir)))
}

/// `path` with its links resolved, even when its last parts do not exist yet: the canonical
/// form of its deepest existing ancestor joined with the rest.
pub(super) fn real_location(path: &Path) -> Option<PathBuf> {
    let mut missing = Vec::new();
    let mut at = path;
    loop {
        if let Ok(real) = fs::canonicalize(at) {
            return Some(missing.into_iter().rev().fold(real, |real, part| real.join(part)));
        }
        missing.push(at.file_name()?);
        at = at.parent()?;
    }
}

/// A checkout's repository top level, resolved once so [`Checkout::entry`] can build every
/// exclude line of an operation without running Git per file.
pub struct Checkout {
    root: PathBuf,
    /// The canonical top level; None when it cannot be resolved (some Windows virtual drives).
    real_top: Option<PathBuf>,
}

impl Checkout {
    /// The checkout at `root`, or None outside Git.
    pub fn open(root: &Path) -> Option<Self> {
        let top = git_path(root, "--show-toplevel")?;
        Some(Self { root: root.to_path_buf(), real_top: fs::canonicalize(top).ok() })
    }

    /// Where `root` sits below the repository's top level (empty at the top level itself).
    fn prefix(&self) -> Option<PathBuf> {
        match &self.real_top {
            Some(real_top) => fs::canonicalize(&self.root).ok()?.strip_prefix(real_top).ok().map(Path::to_path_buf),
            None => git_output(&self.root, "--show-prefix").map(PathBuf::from),
        }
    }

    /// The exclude line for `path` (below `root`) as named, links along it not followed:
    /// what [`Checkout::entry`] gave at activation for a link since replaced by a real folder.
    fn plain_entry(&self, path: &Path, folder: bool) -> Option<String> {
        line_of(&self.prefix()?.join(path.strip_prefix(&self.root).ok()?), folder)
    }

    /// The exclude line for `path` (`/CLAUDE.md`, `/.claude/skills/x/`). Built from where the
    /// files really land, relative to the repository's top level: Git matches exclude patterns
    /// there and does not follow a linked folder (`.agents/skills -> ../.claude/skills`), and
    /// `root` may be a subfolder of the repository. When either cannot be resolved (some
    /// Windows virtual drives) the unresolved paths are used, so the files are still excluded;
    /// None when the files really land outside the repository.
    /// Each part is escaped ([`escape_part`]) so the line matches only that literal path.
    pub fn entry(&self, path: &Path, folder: bool) -> Option<String> {
        self.line(path, folder).ok().flatten()
    }

    /// [`Checkout::entry`], refusing a path with a control character: a cloned folder named
    /// `x\n*` must never add a `*` line of its own to the shared exclude list.
    fn line(&self, path: &Path, folder: bool) -> Result<Option<String>, String> {
        let relative = match (&self.real_top, real_location(path)) {
            (Some(real_top), Some(real)) => real.strip_prefix(real_top).ok().map(Path::to_path_buf),
            // `--show-prefix` is where `root` sits below the top level (`app/`, or empty).
            _ => git_output(&self.root, "--show-prefix").zip(path.strip_prefix(&self.root).ok()).map(|(prefix, rest)| Path::new(&prefix).join(rest)),
        };
        let Some(relative) = relative else { return Ok(None) };
        line_of(&relative, folder).map(Some).ok_or_else(|| format!("{:?} has a control character in its path; PandaCode will not add it to the Git exclude list.", path.display().to_string()))
    }
}

/// The exclude line `/a/b` (`/a/b/` for a folder) for `relative` (below the top level), each
/// part escaped ([`escape_part`]); None when a part holds a control character.
fn line_of(relative: &Path, folder: bool) -> Option<String> {
    let parts: Vec<String> = relative.components().map(|part| part.as_os_str().to_string_lossy().into_owned()).collect();
    if parts.iter().any(|part| part.chars().any(char::is_control)) {
        return None;
    }
    let relative: Vec<String> = parts.iter().map(|part| escape_part(part)).collect();
    Some(format!("/{}{}", relative.join("/"), if folder { "/" } else { "" }))
}

/// `part` with gitignore's special characters backslash-escaped: `*`, `?`, `[` and `\`
/// anywhere, a leading `!` or `#`, and trailing spaces.
fn escape_part(part: &str) -> String {
    let kept = part.trim_end_matches(' ');
    let mut out = String::new();
    for (at, c) in kept.chars().enumerate() {
        if matches!(c, '*' | '?' | '[' | '\\') || (at == 0 && matches!(c, '!' | '#')) {
            out.push('\\');
        }
        out.push(c);
    }
    out + &"\\ ".repeat(part.len() - kept.len())
}

/// The exclude line for `path` in the checkout at `root` ([`Checkout::entry`]): None outside
/// Git, refused when the path holds a control character.
pub fn exclude_entry(root: &Path, path: &Path, folder: bool) -> Result<Option<String>, String> {
    match Checkout::open(root) {
        Some(checkout) => checkout.line(path, folder),
        None => Ok(None),
    }
}

/// Whether `line`, recorded in an activation's exclude list `list`, is one PandaCode builds for
/// `path` (its skill folder or rule file) in the checkout at `base`. A skill folder's line may
/// have been built through a link since replaced (`.agents/skills -> ../.claude/skills`, now a
/// real folder), so for a folder `<skills folder>/<id>` the same id under each project skills
/// folder ([`SKILL_FOLDERS`]) counts as well; a link into a deeper folder is not followed back.
/// With `checkout` open: [`Checkout::entry`] for `path`, or the line for any of those folders
/// built without following links ([`Checkout::plain_entry`]). Once the checkout is gone, the
/// same lines built from where `base` sat below the top level, derived from `list`
/// ([`gone_prefix`]); when that cannot be derived (no list recorded, or `base` inside a
/// removed worktree's subfolder), any line ending in `path` relative to `base`. Builds up to
/// 0.3.114 wrote `/<path relative to base>` unresolved and unescaped; that line counts too
/// while `base` is (or was) the top level (from a subfolder it names a path at the repository's
/// root, maybe the user's own line). A tampered record's other lines (`/src/`) are never
/// dropped from the user's exclude list.
pub fn own_line(checkout: Option<&Checkout>, list: Option<&Path>, base: &Path, path: &Path, folder: bool, line: &str) -> bool {
    let Ok(relative) = path.strip_prefix(base) else { return false };
    if relative.as_os_str().is_empty() || line.chars().any(char::is_control) {
        return false;
    }
    let legacy = format!("/{}{}", relative.to_string_lossy().replace('\\', "/"), if folder { "/" } else { "" });
    let named = |path: &Path| -> Vec<PathBuf> {
        let mut named = vec![path.to_path_buf()];
        if let (true, Some(id)) = (folder, path.file_name()) {
            named.extend(SKILL_FOLDERS.iter().map(|dir| base.join(dir).join(id)));
        }
        named
    };
    if let Some(checkout) = checkout {
        let prefix = checkout.prefix();
        return checkout.entry(path, folder).as_deref() == Some(line)
            || named(path).iter().any(|p| checkout.plain_entry(p, folder).as_deref() == Some(line))
            || (legacy == line && prefix.is_some_and(|prefix| prefix.as_os_str().is_empty()));
    }
    if let Some(prefix) = list.and_then(|list| gone_prefix(list, base)) {
        return (legacy == line && prefix.as_os_str().is_empty())
            || named(path).iter().any(|p| p.strip_prefix(base).ok().and_then(|rest| line_of(&prefix.join(rest), folder)).as_deref() == Some(line));
    }
    let parts: Vec<String> = relative.components().map(|part| escape_part(&part.as_os_str().to_string_lossy())).collect();
    let suffix = format!("/{}{}", parts.join("/"), if folder { "/" } else { "" });
    legacy == line || (line.starts_with('/') && line.ends_with(&suffix))
}

/// Where the gone checkout `base` sat below its top level, from the exclude list `list` it
/// used (`<git dir>/info/exclude`): below a linked worktree `list`'s Git folder still registers
/// (`worktrees/*/gitdir` naming `<top>/.git`), else below the folder holding a Git folder named
/// `.git`, the main checkout. None when `base` is in neither (a removed worktree's subfolder
/// whose registration was pruned).
fn gone_prefix(list: &Path, base: &Path) -> Option<PathBuf> {
    let git_dir = list.parent()?.parent()?;
    let bases = [Some(base.to_path_buf()), real_location(base)];
    let below = |top: &Path| -> Option<PathBuf> {
        let tops = [Some(top.to_path_buf()), real_location(top)];
        bases.iter().flatten().find_map(|base| tops.iter().flatten().find_map(|top| base.strip_prefix(top).ok().map(Path::to_path_buf)))
    };
    let registered = fs::read_dir(git_dir.join("worktrees")).into_iter().flatten().flatten().filter_map(|entry| {
        let named = PathBuf::from(read_text(&entry.path().join("gitdir")).ok()?.trim());
        below(named.parent()?)
    });
    // The deepest top level holding `base`: a worktree nested inside the main checkout's folder.
    let main = (git_dir.file_name()? == ".git").then(|| git_dir.parent().and_then(below)).flatten();
    registered.chain(main).min_by_key(|prefix| prefix.components().count())
}

/// Whether the exclude-list `line` is `entry`, ignoring surrounding whitespace except an
/// escaped trailing space.
fn is_line(line: &str, entry: &str) -> bool {
    line.trim() == entry || line.trim_start().trim_end_matches('\r') == entry
}

/// The exclude list's text: bounded, from a regular file only and never through a link, so a
/// FIFO there never blocks (under the library lock). A missing file is empty; anything else
/// that cannot be read as text is refused, so the user's lines are never rewritten blind.
fn read_exclude(file: &Path) -> Result<String, String> {
    let refused = |e: &dyn std::fmt::Display| format!("Could not read the Git exclude list {}: {e}. PandaCode left it unchanged.", file.display());
    match crate::workspace::read_regular(file, READ_LIMIT) {
        Ok(bytes) => String::from_utf8(bytes).map_err(|_| refused(&"it is not UTF-8 text")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(refused(&e)),
    }
}

/// Add `entry` to the checkout's exclude list; returns whether this call added it.
pub fn exclude(root: &Path, entry: &str) -> Result<bool, String> {
    let Some((file, git_dir)) = exclude_file(root)? else { return Ok(false) };
    let text = read_exclude(&file)?;
    if text.lines().any(|line| is_line(line, entry)) {
        return Ok(false);
    }
    if entry.chars().any(char::is_control) {
        return Err(format!("{entry:?} has a control character; PandaCode will not add it to the Git exclude list."));
    }
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let separator = if text.is_empty() || text.ends_with('\n') { "" } else { "\n" };
    write_exclude(&file, &git_dir, format!("{text}{separator}{entry}\n").as_bytes()).map_err(|e| format!("Could not update the Git exclude list: {e}"))?;
    Ok(true)
}

/// The checkout's exclude list, to tell whether two checkouts share one (linked worktrees).
pub fn exclude_list(root: &Path) -> Option<PathBuf> {
    exclude_file(root).ok().flatten().map(|(file, _)| file)
}

/// Drop `entry` from the checkout's exclude list; a linked or unreadable exclude file is left
/// alone and reported.
pub fn unexclude(root: &Path, entry: &str) -> Result<(), String> {
    match exclude_file(root)? {
        Some((file, git_dir)) => drop_line(&file, &git_dir, entry),
        None => Ok(()),
    }
}

/// Whether a recorded exclude list path still looks like one: `<git dir>/info/exclude`, where
/// the Git folder holds `HEAD` and `objects` or `commondir`, with no link anywhere along it (it
/// was recorded canonical). This only rules out an arbitrary file; it does not say whose
/// repository it is, so callers also tie it to the activation's checkout
/// ([`registers_worktree`]) or to a live checkout that uses it.
pub fn trusted_exclude_list(file: &Path) -> bool {
    let info = file.parent().filter(|info| file.file_name().is_some_and(|n| n == "exclude") && info.file_name().is_some_and(|n| n == "info"));
    let git_dir = info.and_then(Path::parent);
    git_dir.is_some_and(|dir| dir.join("HEAD").is_file() && (dir.join("objects").is_dir() || dir.join("commondir").is_file()))
        && fs::canonicalize(file).is_ok_and(|real| real == file)
}

/// Whether the Git folder holding the exclude list `list` still registers `checkout` as one of
/// its linked worktrees (`<git dir>/worktrees/*/gitdir` naming `<checkout>/.git`), as it does
/// for a worktree deleted without `git worktree prune`.
pub fn registers_worktree(list: &Path, checkout: &Path) -> bool {
    let Some(git_dir) = list.parent().and_then(Path::parent) else { return false };
    let dot_git = checkout.join(".git");
    let names = [Some(dot_git.clone()), real_location(&dot_git)];
    let Ok(entries) = fs::read_dir(git_dir.join("worktrees")) else { return false };
    entries.flatten().any(|entry| {
        read_text(&entry.path().join("gitdir")).is_ok_and(|text| names.iter().flatten().any(|name| Path::new(text.trim()) == name))
    })
}

/// Whether the exclude list at `list` holds the line `entry`.
pub fn lists_line(list: &Path, entry: &str) -> bool {
    read_exclude(list).is_ok_and(|text| text.lines().any(|line| is_line(line, entry)))
}

/// Drop `entry` from the exclude list at `file`, recorded when its checkout still existed:
/// only while it is still a Git exclude list ([`trusted_exclude_list`]). A file that is gone
/// has nothing to drop.
pub fn unexclude_at(file: &Path, entry: &str) -> Result<(), String> {
    if fs::symlink_metadata(file).is_err() {
        return Ok(());
    }
    let git_dir = file.parent().and_then(Path::parent).filter(|_| trusted_exclude_list(file));
    let git_dir = git_dir.ok_or_else(|| format!("{} is not a Git exclude list (or is behind a link); PandaCode left it unchanged.", file.display()))?;
    drop_line(file, git_dir, entry)
}

/// Rewrites `file` without `entry`; a file without it is not touched.
fn drop_line(file: &Path, git_dir: &Path, entry: &str) -> Result<(), String> {
    let text = read_exclude(file)?;
    if !text.lines().any(|line| is_line(line, entry)) {
        return Ok(());
    }
    let kept: Vec<&str> = text.lines().filter(|line| !is_line(line, entry)).collect();
    let next = if kept.is_empty() { String::new() } else { format!("{}\n", kept.join("\n")) };
    write_exclude(file, git_dir, next.as_bytes())
}

/// Writes the exclude list `file` in `git_dir`: replaced whole when it exists, so a failed
/// write never truncates the user's lines, and created exclusively when it does not.
fn write_exclude(file: &Path, git_dir: &Path, bytes: &[u8]) -> Result<(), String> {
    let new = fs::symlink_metadata(file).is_err();
    write_file_as(file, bytes, Some(git_dir), Links::Git, new)
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

/// A test-only hook that makes a write fail after its file was created and part of it written.
#[cfg(not(test))]
mod fail_point {
    #[inline(always)]
    pub fn before_write(_: &std::path::Path, _: &mut std::fs::File, _: &[u8]) -> std::io::Result<()> {
        Ok(())
    }
}
#[cfg(test)]
pub(super) mod fail_point {
    use std::{cell::RefCell, io::Write as _, path::Path};
    type Hook = Box<dyn FnMut(&Path) -> std::io::Result<()>>;
    thread_local!(static HOOK: RefCell<Option<Hook>> = RefCell::new(None));
    /// Runs `hook` before each in-place write on this thread; an error fails that write after
    /// half its bytes landed.
    pub fn set(hook: impl FnMut(&Path) -> std::io::Result<()> + 'static) {
        HOOK.with(|h| *h.borrow_mut() = Some(Box::new(hook)));
    }
    pub fn clear() {
        HOOK.with(|h| *h.borrow_mut() = None);
    }
    pub fn before_write(path: &Path, file: &mut std::fs::File, bytes: &[u8]) -> std::io::Result<()> {
        let failed = HOOK.with(|h| h.borrow_mut().as_mut().map_or(Ok(()), |hook| hook(path)));
        if failed.is_err() {
            file.write_all(&bytes[..bytes.len() / 2])?;
        }
        failed
    }
}
