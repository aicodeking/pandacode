use crate::{
    storage::{self, Session, Store},
    workspace, AppState, Result,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};

const FILE_BYTES: usize = 8 * 1024 * 1024;
const TOTAL_BYTES: usize = 64 * 1024 * 1024;
const PATCH_BYTES: usize = 32 * 1024 * 1024;
const PREVIEW_BYTES: usize = 512 * 1024;
const RETAIN_SECONDS: i64 = 30 * 24 * 60 * 60;

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Result<Self> {
        let path = std::env::temp_dir().join(format!("pandacode-cp-{}", storage::id()));
        fs::create_dir(&path).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        Ok(Self(path))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn git(
    root: &Path,
    index: Option<&Path>,
    args: &[&str],
    input: Option<&[u8]>,
    limit: usize,
) -> Result<Vec<u8>> {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    let isolated = if args.first() == Some(&"apply") {
        let scratch = Scratch::new()?;
        git(
            root,
            None,
            &[
                "init",
                "-q",
                "--bare",
                "--template=",
                scratch.0.to_str().ok_or("Invalid temporary path.")?,
            ],
            None,
            8192,
        )?;
        fs::create_dir_all(scratch.0.join("info")).map_err(|e| e.to_string())?;
        fs::write(
            scratch.0.join("info/attributes"),
            b"* -text -filter -ident -working-tree-encoding -eol\n",
        )
        .map_err(|e| e.to_string())?;
        command
            .arg("--git-dir")
            .arg(&scratch.0)
            .arg("--work-tree")
            .arg(root)
            .args(["-c", "core.bare=false"])
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .env("GIT_CONFIG_NOSYSTEM", "1");
        Some(scratch)
    } else {
        None
    };
    command
        .args([
            "--no-pager",
            "--literal-pathspecs",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.attributesFile=/dev/null",
            "-c",
            "color.ui=false",
            "-c",
            "core.autocrlf=false",
            "-c",
            "core.safecrlf=false",
            "-c",
            "commit.gpgSign=false",
        ])
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "PandaCode")
        .env("GIT_AUTHOR_EMAIL", "checkpoint@pandacode.invalid")
        .env("GIT_COMMITTER_NAME", "PandaCode")
        .env("GIT_COMMITTER_EMAIL", "checkpoint@pandacode.invalid");
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    let output = workspace::run_process_with_input(
        command,
        "Git checkpoint",
        limit,
        Duration::from_secs(30),
        input,
    )?;
    drop(isolated);
    if !output.status.success() {
        let detail = if output.stderr.bytes.is_empty() {
            &output.stdout.bytes
        } else {
            &output.stderr.bytes
        };
        return Err(format!(
            "Git checkpoint {} failed ({}): {}",
            args.first().copied().unwrap_or("command"),
            output.status,
            String::from_utf8_lossy(detail).trim()
        ));
    }
    if output.stdout.truncated {
        return Err("Checkpoint exceeded its size limit. No files were restored.".into());
    }
    Ok(output.stdout.bytes)
}
fn string(bytes: Vec<u8>) -> Result<String> {
    String::from_utf8(bytes)
        .map(|s| s.trim_end_matches('\n').to_owned())
        .map_err(|_| "Checkpoint contains a filename that is not UTF-8.".into())
}
fn oid(bytes: Vec<u8>) -> Result<String> {
    let value = string(bytes)?;
    if !matches!(value.len(), 40 | 64) || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid checkpoint object.".into());
    }
    Ok(value)
}
fn prefix(session: &str) -> Result<String> {
    if session.is_empty()
        || session.len() > 128
        || !session
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("Invalid checkpoint session.".into());
    }
    Ok(format!("refs/pandacode/cp/{session}/"))
}
fn reference(session: &str, message: i64) -> Result<String> {
    if message <= 0 {
        return Err("Choose a saved user message.".into());
    }
    Ok(format!("{}{message}", prefix(session)?))
}
fn valid_path(path: &str) -> bool {
    !path.is_empty() && !path.contains('\\') && !path.contains('\0') && Path::new(path).components().all(|part| matches!(part, Component::Normal(name) if !name.to_string_lossy().eq_ignore_ascii_case(".git")))
}
fn checkout(root: &Path) -> Result<PathBuf> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let top = string(git(
        &root,
        None,
        &["rev-parse", "--show-toplevel"],
        None,
        8192,
    )?)?;
    if Path::new(&top).canonicalize().map_err(|e| e.to_string())? != root {
        return Err("Checkpoints require a project opened at its Git working-tree root.".into());
    }
    Ok(root)
}
fn identity(root: &Path) -> Result<String> {
    let dir = git(root, None, &["rev-parse", "--absolute-git-dir"], None, 8192)?;
    Ok(format!(
        "{:x}",
        Sha256::digest([root.as_os_str().as_encoded_bytes(), b"\0", &dir].concat())
    ))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Snapshot {
    tree: String,
    checkout: String,
    skipped: BTreeSet<String>,
}
#[derive(Clone, Debug, PartialEq)]
struct Entry {
    mode: String,
    hash: String,
}
type Entries = BTreeMap<String, Entry>;

fn tree(root: &Path, entries: &Entries) -> Result<String> {
    let scratch = Scratch::new()?;
    let index = scratch.0.join("index");
    git(root, Some(&index), &["read-tree", "--empty"], None, 8192)?;
    let mut data = Vec::new();
    for (path, entry) in entries {
        data.extend_from_slice(format!("{} {}\t{}\0", entry.mode, entry.hash, path).as_bytes());
    }
    git(
        root,
        Some(&index),
        &["update-index", "-z", "--index-info"],
        Some(&data),
        8192,
    )?;
    oid(git(root, Some(&index), &["write-tree"], None, 8192)?)
}
fn entries(root: &Path, tree: &str) -> Result<Entries> {
    let data = git(root, None, &["ls-tree", "-rz", tree], None, 4 * 1024 * 1024)?;
    let mut entries = Entries::new();
    for record in data.split(|b| *b == 0).filter(|s| !s.is_empty()) {
        let record = std::str::from_utf8(record).map_err(|_| "Invalid checkpoint filename.")?;
        let (header, path) = record.split_once('\t').ok_or("Invalid checkpoint tree.")?;
        let fields: Vec<_> = header.split(' ').collect();
        if fields.len() != 3
            || fields[1] != "blob"
            || !matches!(fields[0], "100644" | "100755" | "120000")
            || !valid_path(path)
        {
            return Err("Unsupported checkpoint entry.".into());
        }
        entries.insert(
            path.into(),
            Entry {
                mode: fields[0].into(),
                hash: fields[2].into(),
            },
        );
    }
    Ok(entries)
}
fn snapshot(root: &Path) -> Result<Snapshot> {
    let (paths, ignored, truncated) =
        workspace::turn_snapshot_paths(root, Instant::now() + Duration::from_secs(30))?
            .ok_or("This folder is not a Git repository.")?;
    let paths: BTreeSet<_> = paths.into_iter().collect();
    if truncated || paths.len() > 10_000 {
        return Err("This checkout exceeds the checkpoint file limit.".into());
    }
    let scratch = Scratch::new()?;
    let mut skipped: BTreeSet<_> = ignored
        .into_iter()
        .map(|p| p.trim_end_matches('/').to_owned())
        .collect();
    let mut files = Vec::new();
    let mut input = String::new();
    let mut total = 0;
    for path in paths {
        if !valid_path(&path) {
            return Err("This checkout contains an unsupported filename.".into());
        }
        let limit = FILE_BYTES.min(TOTAL_BYTES - total);
        if limit == 0 {
            skipped.insert(path);
            continue;
        }
        let (bytes, metadata, link) = match crate::turn_changes::read_bytes(root, &path, limit) {
            Ok(value) => value,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                skipped.insert(path);
                continue;
            }
        };
        if !link && metadata.len() > limit as u64 || bytes.len() > limit {
            skipped.insert(path);
            continue;
        }
        total += bytes.len();
        let mode = if link {
            "120000"
        } else {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o111 != 0 {
                    "100755"
                } else {
                    "100644"
                }
            }
            #[cfg(not(unix))]
            {
                "100644"
            }
        };
        let temp = scratch.0.join(files.len().to_string());
        fs::write(&temp, &bytes).map_err(|e| e.to_string())?;
        input.push_str(&serde_json::to_string(&temp.to_string_lossy()).map_err(|e| e.to_string())?);
        input.push('\n');
        files.push((path, mode));
    }
    let hashes = string(git(
        root,
        None,
        &["hash-object", "-w", "--no-filters", "--stdin-paths"],
        Some(input.as_bytes()),
        1024 * 1024,
    )?)?;
    let hashes: Vec<_> = hashes.lines().collect();
    if hashes.len() != files.len() {
        return Err("Could not store all checkpoint files.".into());
    }
    let entries = files
        .into_iter()
        .zip(hashes)
        .map(|((path, mode), hash)| {
            (
                path,
                Entry {
                    mode: mode.into(),
                    hash: hash.into(),
                },
            )
        })
        .collect();
    Ok(Snapshot {
        tree: tree(root, &entries)?,
        checkout: identity(root)?,
        skipped,
    })
}
fn save(root: &Path, reference: &str, snapshot: &Snapshot) -> Result<String> {
    let metadata = serde_json::to_vec(snapshot).map_err(|e| e.to_string())?;
    let commit = oid(git(
        root,
        None,
        &["commit-tree", &snapshot.tree],
        Some(&metadata),
        1024 * 1024,
    )?)?;
    git(
        root,
        None,
        &["update-ref", reference, &commit, ""],
        None,
        8192,
    )?;
    Ok(commit)
}
fn load(root: &Path, reference: &str) -> Result<Snapshot> {
    let commit = oid(git(
        root,
        None,
        &["rev-parse", "--verify", reference],
        None,
        8192,
    )
    .map_err(|_| {
        "No checkpoint is available for this message. It may predate checkpoints or have expired."
    })?)?;
    let data = git(
        root,
        None,
        &["show", "-s", "--format=%B", &commit],
        None,
        2 * 1024 * 1024,
    )?;
    let snapshot: Snapshot =
        serde_json::from_slice(&data).map_err(|_| "Invalid checkpoint metadata.")?;
    if snapshot.checkout != identity(root)? {
        return Err("This checkpoint belongs to a different checkout.".into());
    }
    let actual = oid(git(
        root,
        None,
        &["rev-parse", &format!("{commit}^{{tree}}")],
        None,
        8192,
    )?)?;
    if actual != snapshot.tree {
        return Err("Checkpoint tree does not match its metadata.".into());
    }
    Ok(snapshot)
}
fn collect(root: &Path) -> Result<()> {
    let refs = string(git(
        root,
        None,
        &[
            "for-each-ref",
            "--format=%(refname) %(objectname) %(committerdate:unix)",
            "refs/pandacode/cp/",
        ],
        None,
        4 * 1024 * 1024,
    )?)?;
    let cutoff = storage::now() / 1000 - RETAIN_SECONDS;
    for line in refs.lines() {
        let parts: Vec<_> = line.split(' ').collect();
        if parts.len() == 3 && parts[2].parse::<i64>().is_ok_and(|time| time < cutoff) {
            git(
                root,
                None,
                &["update-ref", "-d", parts[0], parts[1]],
                None,
                8192,
            )?;
        }
    }
    Ok(())
}
pub(crate) fn capture(root: &Path, session: &str, message: i64) -> Result<()> {
    let root = checkout(root)?;
    let reference = reference(session, message)?;
    collect(&root)?;
    save(&root, &reference, &snapshot(&root)?)?;
    Ok(())
}

fn context(store: &Store, session: &str) -> Result<PathBuf> {
    let task = store.session(session)?;
    if task.remote_device.is_some() || task.cloud.is_some() {
        return Err("Checkpoints are available only for local checkouts.".into());
    }
    let root = checkout(&store.workspace_root(&task.project_id, Some(session))?)?;
    collect(&root)?;
    Ok(root)
}
fn user_message(store: &Store, session: &str, message: i64) -> Result<()> {
    let valid: bool = store
        .db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE session_id=?1 AND id=?2 AND role='user')",
            rusqlite::params![session, message],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !valid {
        return Err("Choose a saved user message from this task.".into());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    message_id: i64,
    created_at: i64,
    skipped: usize,
}
#[tauri::command]
pub async fn list_checkpoints(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<Checkpoint>> {
    let store = state.store.clone();
    crate::blocking(move || {
        let store = store.lock().map_err(|e| e.to_string())?;
        let root = context(&store, &session_id)?;
        let prefix = prefix(&session_id)?;
        let refs = string(git(
            &root,
            None,
            &[
                "for-each-ref",
                "--format=%(refname) %(committerdate:unix)",
                &prefix,
            ],
            None,
            1024 * 1024,
        )?)?;
        let mut result = Vec::new();
        for line in refs.lines() {
            let Some((reference, time)) = line.split_once(' ') else {
                continue;
            };
            let Some(message) = reference
                .strip_prefix(&prefix)
                .and_then(|s| s.parse::<i64>().ok())
            else {
                continue;
            };
            if user_message(&store, &session_id, message).is_err() {
                continue;
            }
            if let Ok(saved) = load(&root, reference) {
                result.push(Checkpoint {
                    message_id: message,
                    created_at: time.parse::<i64>().unwrap_or_default() * 1000,
                    skipped: saved.skipped.len(),
                });
            }
        }
        result.sort_by_key(|c| c.message_id);
        Ok(result)
    })
    .await
}

fn patch(
    root: &Path,
    from: &Snapshot,
    to: &Snapshot,
) -> Result<(Vec<u8>, Vec<String>, Vec<String>)> {
    let skipped: BTreeSet<_> = from.skipped.union(&to.skipped).cloned().collect();
    let eligible = |path: &str| {
        !skipped.iter().any(|skip| {
            path == skip
                || path
                    .strip_prefix(skip)
                    .is_some_and(|tail| tail.starts_with('/'))
                || skip
                    .strip_prefix(path)
                    .is_some_and(|tail| tail.starts_with('/'))
        })
    };
    let filter = |snapshot: &Snapshot| -> Result<String> {
        let mut entries = entries(root, &snapshot.tree)?;
        entries.retain(|path, _| eligible(path));
        tree(root, &entries)
    };
    let from = filter(from)?;
    let to = filter(to)?;
    let data = git(
        root,
        None,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--binary",
            "--full-index",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            &from,
            &to,
            "--",
        ],
        None,
        PATCH_BYTES,
    )?;
    let names = git(
        root,
        None,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--name-only",
            "-z",
            &from,
            &to,
            "--",
        ],
        None,
        2 * 1024 * 1024,
    )?;
    let names = names
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| String::from_utf8(p.to_vec()).map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>>>()?;
    Ok((data, names, skipped.into_iter().collect()))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    patch: String,
    files: Vec<String>,
    skipped: Vec<String>,
    truncated: bool,
    token: Option<String>,
}
fn comparison(
    bytes: &[u8],
    files: Vec<String>,
    skipped: Vec<String>,
    token: Option<String>,
) -> Comparison {
    let patch = String::from_utf8_lossy(bytes);
    let mut end = patch.len().min(PREVIEW_BYTES);
    while !patch.is_char_boundary(end) {
        end -= 1;
    }
    Comparison {
        patch: patch[..end].into(),
        files,
        skipped,
        truncated: end < patch.len(),
        token,
    }
}
struct Review {
    session: String,
    message: i64,
    root: PathBuf,
    before: Snapshot,
    target: Snapshot,
    head: Vec<u8>,
    patch: Vec<u8>,
    at: Instant,
}
fn reviews() -> &'static Mutex<HashMap<String, Review>> {
    static REVIEWS: OnceLock<Mutex<HashMap<String, Review>>> = OnceLock::new();
    REVIEWS.get_or_init(Default::default)
}
fn head(root: &Path) -> Result<Vec<u8>> {
    git(root, None, &["rev-parse", "--verify", "HEAD"], None, 8192)
        .or_else(|_| git(root, None, &["symbolic-ref", "HEAD"], None, 8192))
}

#[tauri::command]
pub async fn compare_checkpoints(
    state: State<'_, AppState>,
    session_id: String,
    from_message: i64,
    to_message: i64,
) -> Result<Comparison> {
    let store = state.store.clone();
    crate::blocking(move || {
        let store = store.lock().map_err(|e| e.to_string())?;
        let root = context(&store, &session_id)?;
        user_message(&store, &session_id, from_message)?;
        user_message(&store, &session_id, to_message)?;
        let (patch, files, skipped) = patch(
            &root,
            &load(&root, &reference(&session_id, from_message)?)?,
            &load(&root, &reference(&session_id, to_message)?)?,
        )?;
        Ok(comparison(&patch, files, skipped, None))
    })
    .await
}
#[tauri::command]
pub async fn preview_rewind(
    state: State<'_, AppState>,
    session_id: String,
    message_id: i64,
) -> Result<Comparison> {
    let store = state.store.clone();
    crate::blocking(move || {
        let store = store.lock().map_err(|e| e.to_string())?;
        let root = context(&store, &session_id)?;
        user_message(&store, &session_id, message_id)?;
        let target = load(&root, &reference(&session_id, message_id)?)?;
        let before = snapshot(&root)?;
        let (patch, files, skipped) = patch(&root, &before, &target)?;
        if !patch.is_empty() {
            git(
                &root,
                None,
                &["apply", "--check", "--binary", "--whitespace=nowarn", "-"],
                Some(&patch),
                64 * 1024,
            )?;
        }
        let token = storage::id();
        let result = comparison(&patch, files, skipped, Some(token.clone()));
        let review = Review {
            session: session_id,
            message: message_id,
            head: head(&root)?,
            root,
            before,
            target,
            patch,
            at: Instant::now(),
        };
        let mut reviews = reviews().lock().map_err(|e| e.to_string())?;
        reviews.retain(|_, review| review.at.elapsed() < Duration::from_secs(600));
        if reviews.len() >= 16 {
            return Err("Close an earlier rewind preview and try again in a few minutes.".into());
        }
        reviews.insert(token, review);
        Ok(result)
    })
    .await
}

fn restore(state: &AppState, session: &str, message: i64, token: &str) -> Result<Session> {
    let review = reviews()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(token)
        .ok_or("Reopen the rewind preview before restoring.")?;
    if review.session != session
        || review.message != message
        || review.at.elapsed() >= Duration::from_secs(600)
    {
        return Err("This rewind preview has expired. Review it again.".into());
    }
    let agents = state.agents.lock().map_err(|e| e.to_string())?;
    if state.shutdown.load(std::sync::atomic::Ordering::SeqCst) != 0 {
        return Err("PandaCode is shutting down.".into());
    }
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let parent = crate::architect::parent_of(&store, session)?;
    crate::architect::check_manual(&store, parent.as_deref().unwrap_or(session))?;
    let root = context(&store, session)?;
    if root != review.root {
        return Err("The task's checkout changed. Review the rewind again.".into());
    }
    let mut busy: BTreeSet<String> = agents.keys().cloned().collect();
    let mut query = store.db.prepare("SELECT id FROM sessions WHERE json_extract(goal_state,'$.status')='active' UNION SELECT session_id FROM architect_teams WHERE json_extract(content,'$.status') IN ('running','waiting')").map_err(|e| e.to_string())?;
    for id in query
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
    {
        busy.insert(id.map_err(|e| e.to_string())?);
    }
    for id in &busy {
        let task = store.session(id)?;
        let active = store
            .workspace_root(&task.project_id, Some(id))?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if active.starts_with(&root) || root.starts_with(&active) {
            return Err("Stop all agents and pause active teams or goals using this checkout before rewinding.".into());
        }
    }
    if crate::terminal::has_open_roots(&state.terminals, std::slice::from_ref(&root))? {
        return Err("Close terminals using this checkout before rewinding.".into());
    }
    user_message(&store, session, message)?;
    let target = load(&root, &reference(session, message)?)?;
    let current = snapshot(&root)?;
    if current.tree != review.before.tree
        || current.skipped != review.before.skipped
        || head(&root)? != review.head
        || target.tree != review.target.tree
        || target.skipped != review.target.skipped
    {
        return Err("Files or Git history changed after the preview. Review the rewind again; no files were restored.".into());
    }
    if !review.patch.is_empty() {
        git(
            &root,
            None,
            &["apply", "--check", "--binary", "--whitespace=nowarn", "-"],
            Some(&review.patch),
            64 * 1024,
        )?;
    }
    let recovery = format!("{}recovery-{}", prefix(session)?, storage::id());
    save(&root, &recovery, &current)?;
    let fork = crate::conversation_fork::before_message(&store, session, message)?;
    if !review.patch.is_empty() {
        if let Err(error) = git(
            &root,
            None,
            &["apply", "--binary", "--whitespace=nowarn", "-"],
            Some(&review.patch),
            64 * 1024,
        ) {
            let _ = store
                .db
                .execute("DELETE FROM sessions WHERE id=?1", [&fork.id]);
            return Err(format!(
                "Restore failed: {error}. The pre-restore files are saved at {recovery}."
            ));
        }
    }
    Ok(fork)
}
#[tauri::command]
pub fn discard_rewind(token: String) {
    if let Ok(mut reviews) = reviews().lock() {
        reviews.remove(&token);
    }
}
#[tauri::command]
pub async fn rewind_checkpoint(
    app: tauri::AppHandle,
    session_id: String,
    message_id: i64,
    token: String,
) -> Result<Session> {
    let app_for_work = app.clone();
    let task = crate::blocking(move || {
        restore(
            &app_for_work.state::<AppState>(),
            &session_id,
            message_id,
            &token,
        )
    })
    .await?;
    let _ = app.emit("sessions-changed", ());
    Ok(task)
}

#[cfg(test)]
mod tests;
