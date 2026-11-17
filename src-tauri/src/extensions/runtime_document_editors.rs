//! Custom editors bound to audited host buffers (runtime phase R9, slice R0901).
//!
//! * **Declaration.** `contributes.editors[]` (`id`, `title`, `extensions`, `priority`, `encoding`, `rich`) is checked
//!   twice with the same rules: the schema bounds the shape, [`check`] (called by `contracts.rs`, mirrored by
//!   `src/extensions/runtime-document-editors.ts` for `contracts.ts`) applies the rest: ids start with the manifest id
//!   plus `/` (`InvalidId`, `ReservedId` for `panda.`), at most 16 editors (`LimitExceeded`), `title` of at most 80
//!   characters, 1 to 16 distinct extensions `^[.][a-z0-9]{1,16}$`, `priority` `default` or `option`, `encoding` `text`
//!   or `bytes`, a `rich` panel whose folder the package ships in `runtime.files` (`UnknownReference`) and the
//!   `documents.editors` permission declared (`PermissionDenied`).
//! * **Selection.** [`select_editor`]: the user's remembered "Open with" choice per file type wins (the built-in editor
//!   included); otherwise one `default` editor opens the file, two make the host ask once (the built-in editor opens
//!   meanwhile), and `option` editors are only offered. The built-in editor and the way back are one click
//!   ([`DocumentEditors::switch_to`]) over the same buffer.
//! * **The buffer is the host's** ([`HostBuffer`]). A panel reads it and hands back the whole buffer with `edit`;
//!   it never writes the file: the host saves, on the user's save and on `document.save()`. Text up to 4 MiB and bytes
//!   up to 16 MiB move as JSON chunks of at most 192 KiB of document bytes ([`chunk_text`], [`chunk_bytes`],
//!   [`Assembler`]); an interrupted transfer is discarded and the buffer is unchanged. A disk change replaces an
//!   unchanged buffer (`onDidReplace`, reason `disk`); a changed buffer keeps its edits and flags a conflict the user
//!   resolves; a revert replaces with reason `revert`. Nothing unsaved is lost to any of them.
//! * **Failure.** A panel that fails, a grant that is revoked or narrowed (rechecked on every read, edit and save) and
//!   a read-only file never touch the buffer: the mount falls back to the built-in editor over the same buffer.
//! * **Audit.** Every mount, read, edit, save, replacement and fallback records the package, project, path, revision and
//!   size, never the content (ADR-0006).
//!
//! Where the editor mounts (the original's floating editor window, the inspector as fallback) is a `Placement` of the
//! mount; the window itself is the original's editor shell, never a second one. Everything here is for predictability,
//! fault isolation and not losing work (ADR-0005): a granted package is never asked per action.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};

/// The permission a package must hold to bind editors (per project).
pub const PERMISSION: &str = "documents.editors";
/// The editor id of the app's own editor.
pub const BUILTIN: &str = "builtin";
pub const MAX_EDITORS: usize = 16;
pub const MAX_EXTENSIONS: usize = 16;
pub const MAX_TITLE: usize = 80;
pub const MAX_TEXT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_BYTES_BYTES: usize = 16 * 1024 * 1024;
pub const CHUNK_BYTES: usize = 192 * 1024;
/// How long the host waits for each `onWillSave` callback of a panel.
pub const WILL_SAVE_WAIT_MS: u64 = 1_000;
const AT: &str = "contributes/editors";

// ---------------------------------------------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------------------------------------------

/// One `contributes.editors[]` entry, with its defaults applied.
#[derive(Clone, Debug, PartialEq)]
pub struct EditorDecl { pub id: String, pub title: String, pub extensions: Vec<String>, pub priority: String, pub encoding: String, pub folder: String, pub entry: String }
impl EditorDecl {
    pub fn json(&self) -> Value {
        json!({"id": self.id, "title": self.title, "extensions": self.extensions, "priority": self.priority, "encoding": self.encoding, "rich": {"folder": self.folder, "entry": self.entry}})
    }
}

/// A refused declaration: the error code, the manifest-relative place and the ids it names.
#[derive(Debug, PartialEq, Eq)]
pub struct Refusal { pub code: &'static str, pub at: &'static str, pub ids: Vec<String> }
fn refuse(code: &'static str, at: &'static str, id: &str) -> Refusal { Refusal { code, at, ids: vec![id.to_owned()] } }

/// `^[.][a-z0-9]{1,16}$`.
pub fn valid_extension(extension: &str) -> bool {
    extension.strip_prefix('.').is_some_and(|rest| (1..=16).contains(&rest.len()) && rest.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()))
}
/// The file type of `path`: its last extension, lower case, or `""`.
pub fn extension_of(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or_default();
    match name.rfind('.') { Some(dot) if dot > 0 => name[dot..].to_lowercase(), _ => String::new() }
}

/// The rules of `contributes.editors` after the schema checked the shape. The order of the checks is the order of
/// `checkEditorDeclarations` in `runtime-document-editors.ts`, so both validators answer the same first refusal.
pub fn check(manifest: &Value) -> Result<Vec<EditorDecl>, Refusal> {
    let Some(list) = manifest["contributes"]["editors"].as_array().filter(|list| !list.is_empty()) else { return Ok(vec![]) };
    let package = manifest["id"].as_str().unwrap_or_default();
    if list.len() > MAX_EDITORS { return Err(refuse("LimitExceeded", AT, package)); }
    let files: BTreeSet<&str> = manifest["runtime"]["files"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let permissions: BTreeSet<&str> = manifest["permissions"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let (mut ids, mut out) = (BTreeSet::new(), Vec::new());
    for editor in list {
        let id = editor["id"].as_str().unwrap_or_default();
        if id.starts_with("panda.") { return Err(refuse("ReservedId", AT, id)); }
        if !id.starts_with(&format!("{package}/")) { return Err(refuse("InvalidId", AT, id)); }
        if !ids.insert(id) { return Err(refuse("DuplicateId", AT, id)); }
        let Some(title) = editor["title"].as_str().filter(|text| !text.trim().is_empty() && text.chars().count() <= MAX_TITLE) else { return Err(refuse("InvalidShape", AT, id)) };
        let Some(extensions) = editor["extensions"].as_array().filter(|list| !list.is_empty()) else { return Err(refuse("InvalidShape", AT, id)) };
        if extensions.len() > MAX_EXTENSIONS { return Err(refuse("LimitExceeded", AT, id)); }
        let names: Vec<&str> = extensions.iter().filter_map(Value::as_str).collect();
        if names.len() != extensions.len() || names.iter().any(|name| !valid_extension(name)) || names.iter().collect::<BTreeSet<_>>().len() != names.len() { return Err(refuse("InvalidShape", AT, id)); }
        let priority = match editor.get("priority") {
            None => "option",
            Some(value) => match value.as_str().filter(|priority| ["default", "option"].contains(priority)) { Some(priority) => priority, None => return Err(refuse("InvalidShape", AT, id)) },
        };
        let encoding = match editor.get("encoding") {
            None => "text",
            Some(value) => match value.as_str().filter(|encoding| ["text", "bytes"].contains(encoding)) { Some(encoding) => encoding, None => return Err(refuse("InvalidShape", AT, id)) },
        };
        let (Some(folder), Some(entry)) = (editor["rich"]["folder"].as_str(), editor["rich"]["entry"].as_str()) else { return Err(refuse("InvalidShape", AT, id)) };
        if !files.contains(folder) { return Err(refuse("UnknownReference", AT, id)); }
        out.push(EditorDecl { id: id.to_owned(), title: title.to_owned(), extensions: names.iter().map(|name| (*name).to_owned()).collect(), priority: priority.to_owned(), encoding: encoding.to_owned(), folder: folder.to_owned(), entry: entry.to_owned() });
    }
    if !permissions.contains(PERMISSION) { return Err(refuse("PermissionDenied", "permissions", package)); }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------------------------
// Which editor opens a file
// ---------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct Entry { pub owner: String, pub version: String, pub package_name: String, pub editors: Vec<EditorDecl> }
#[derive(Clone, Debug)]
pub struct Candidate { pub owner: String, pub version: String, pub package_name: String, pub editor: EditorDecl }
#[derive(Clone, Debug, PartialEq)]
pub struct Selection { pub editor: String, pub reason: &'static str, pub options: Vec<String>, pub ask: Option<Vec<String>> }
impl Selection {
    pub fn json(&self) -> Value {
        let mut value = json!({"editor": self.editor, "reason": self.reason, "options": self.options});
        if let Some(ask) = &self.ask { value["ask"] = json!(ask); }
        value
    }
}

/// The editors of enabled, granted packages that handle `extension`, in a stable order (owner, then id).
pub fn candidates_for(entries: &[Entry], extension: &str, holds: &dyn Fn(&Entry) -> bool) -> Vec<Candidate> {
    let mut out: Vec<Candidate> = entries.iter().filter(|entry| holds(entry)).flat_map(|entry| {
        entry.editors.iter().filter(|editor| editor.extensions.iter().any(|item| item == extension)).map(|editor| Candidate { owner: entry.owner.clone(), version: entry.version.clone(), package_name: entry.package_name.clone(), editor: editor.clone() })
    }).collect();
    out.sort_by(|a, b| (&a.owner, &a.editor.id).cmp(&(&b.owner, &b.editor.id)));
    out
}

/// The editor a file opens in; see the module doc. A remembered editor that is gone or no longer granted is ignored.
pub fn select_editor(candidates: &[Candidate], remembered: Option<&str>) -> Selection {
    let options: Vec<String> = candidates.iter().map(|candidate| candidate.editor.id.clone()).collect();
    if remembered == Some(BUILTIN) { return Selection { editor: BUILTIN.into(), reason: "remembered", options, ask: None }; }
    if let Some(editor) = remembered.filter(|editor| options.iter().any(|option| option.as_str() == *editor)) { return Selection { editor: editor.into(), reason: "remembered", options, ask: None }; }
    let defaults: Vec<String> = candidates.iter().filter(|candidate| candidate.editor.priority == "default").map(|candidate| candidate.editor.id.clone()).collect();
    match defaults.len() {
        0 => Selection { editor: BUILTIN.into(), reason: "builtin", options, ask: None },
        1 => Selection { editor: defaults[0].clone(), reason: "default", options, ask: None },
        _ => Selection { editor: BUILTIN.into(), reason: "conflict", options, ask: Some(defaults) },
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The wire form: chunks
// ---------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub enum Content { Text(String), Bytes(Vec<u8>) }
impl Content {
    pub fn size(&self) -> usize { match self { Content::Text(text) => text.len(), Content::Bytes(bytes) => bytes.len() } }
    fn is_text(&self) -> bool { matches!(self, Content::Text(_)) }
}

/// `{ schemaVersion: 1, transfer, revision, encoding, offset, totalBytes, data, final }`.
#[derive(Clone, Debug, PartialEq)]
pub struct Chunk { pub transfer: String, pub revision: u64, pub encoding: &'static str, pub offset: usize, pub total_bytes: usize, pub data: String, pub is_final: bool }
impl Chunk {
    pub fn json(&self) -> Value {
        json!({"schemaVersion": 1, "transfer": self.transfer, "revision": self.revision, "encoding": self.encoding, "offset": self.offset, "totalBytes": self.total_bytes, "data": self.data, "final": self.is_final})
    }
    pub fn from_json(value: &Value) -> Option<Chunk> {
        if value["schemaVersion"] != 1 { return None; }
        Some(Chunk {
            transfer: value["transfer"].as_str()?.to_owned(),
            revision: value["revision"].as_u64()?,
            encoding: match value["encoding"].as_str()? { "utf8" => "utf8", "base64" => "base64", _ => return None },
            offset: usize::try_from(value["offset"].as_u64()?).ok()?,
            total_bytes: usize::try_from(value["totalBytes"].as_u64()?).ok()?,
            data: value["data"].as_str()?.to_owned(),
            is_final: value["final"].as_bool()?,
        })
    }
}

/// A text document as chunks of at most `max` UTF-8 bytes, each cut at a code point boundary.
pub fn chunk_text(text: &str, transfer: &str, revision: u64, max: usize) -> Vec<Chunk> {
    let (mut chunks, mut current, mut offset) = (Vec::new(), String::new(), 0usize);
    for point in text.chars() {
        if !current.is_empty() && current.len() + point.len_utf8() > max {
            let size = current.len();
            chunks.push(Chunk { transfer: transfer.into(), revision, encoding: "utf8", offset, total_bytes: text.len(), data: std::mem::take(&mut current), is_final: false });
            offset += size;
        }
        current.push(point);
    }
    chunks.push(Chunk { transfer: transfer.into(), revision, encoding: "utf8", offset, total_bytes: text.len(), data: current, is_final: true });
    chunks
}
/// A byte document as base64 chunks of at most `max` document bytes.
pub fn chunk_bytes(bytes: &[u8], transfer: &str, revision: u64, max: usize) -> Vec<Chunk> {
    if bytes.is_empty() { return vec![Chunk { transfer: transfer.into(), revision, encoding: "base64", offset: 0, total_bytes: 0, data: String::new(), is_final: true }]; }
    bytes.chunks(max).enumerate().map(|(index, part)| Chunk {
        transfer: transfer.into(), revision, encoding: "base64", offset: index * max, total_bytes: bytes.len(), data: STANDARD.encode(part), is_final: (index + 1) * max >= bytes.len(),
    }).collect()
}
pub fn chunk_content(content: &Content, transfer: &str, revision: u64) -> Vec<Chunk> {
    match content { Content::Text(text) => chunk_text(text, transfer, revision, CHUNK_BYTES), Content::Bytes(bytes) => chunk_bytes(bytes, transfer, revision, CHUNK_BYTES) }
}

/// One side's transfer in progress: chunks in order, acted on only at `final` with every byte present.
#[derive(Debug)]
pub struct Assembler { text: bool, transfer: Option<String>, expected: usize, data: Vec<u8> }
impl Assembler {
    pub fn new(text: bool) -> Assembler { Assembler { text, transfer: None, expected: 0, data: Vec::new() } }
    pub fn is_open(&self) -> bool { self.transfer.is_some() }
    /// The panel closed mid-transfer, or the host gave up: the partial assembly is gone.
    pub fn discard(&mut self) { self.transfer = None; self.expected = 0; self.data.clear(); }
    /// `Ok(None)` for a chunk taken, `Ok(Some(content))` at the final one; `Err` is `InvalidShape`, `LimitExceeded` or `StaleContext`.
    pub fn accept(&mut self, chunk: &Chunk, host_revision: u64) -> Result<Option<Content>, &'static str> {
        let limit = if self.text { MAX_TEXT_BYTES } else { MAX_BYTES_BYTES };
        if chunk.transfer.is_empty() || chunk.encoding != (if self.text { "utf8" } else { "base64" }) { return Err("InvalidShape"); }
        if chunk.revision < host_revision { self.discard(); return Err("StaleContext"); }
        if self.transfer.as_deref().is_some_and(|open| open != chunk.transfer) { self.discard(); return Err("StaleContext"); }
        if chunk.total_bytes > limit { self.discard(); return Err("LimitExceeded"); }
        let part = if self.text { chunk.data.as_bytes().to_vec() } else { match STANDARD.decode(&chunk.data) { Ok(bytes) => bytes, Err(_) => { self.discard(); return Err("InvalidShape"); } } };
        if part.len() > CHUNK_BYTES { self.discard(); return Err("LimitExceeded"); }
        if self.transfer.is_none() {
            if chunk.offset != 0 { return Err("InvalidShape"); }
            self.transfer = Some(chunk.transfer.clone()); self.expected = chunk.total_bytes;
        } else if chunk.offset != self.data.len() || chunk.total_bytes != self.expected { self.discard(); return Err("InvalidShape"); }
        self.data.extend_from_slice(&part);
        if self.data.len() > self.expected { self.discard(); return Err("InvalidShape"); }
        if !chunk.is_final { return Ok(None); }
        if self.data.len() != self.expected { self.discard(); return Err("InvalidShape"); }
        let all = std::mem::take(&mut self.data);
        self.discard();
        if self.text { String::from_utf8(all).map(|text| Some(Content::Text(text))).map_err(|_| "InvalidShape") } else { Ok(Some(Content::Bytes(all))) }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The host buffer
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum DiskOutcome { Unchanged, Replaced, Conflict }

/// The text or bytes of one open file. The host owns it; panels and the built-in editor are views of it.
#[derive(Debug)]
pub struct HostBuffer {
    pub project_id: String, pub path: String, pub text: bool, pub read_only: bool,
    pub revision: u64,
    /// Edited since the last save or load.
    pub dirty: bool,
    /// The newer disk content that arrived while the buffer was dirty; nothing is lost until the user picks.
    pub conflict: Option<Content>,
    content: Content,
    disk: Content,
}
impl HostBuffer {
    pub fn new(project_id: &str, path: &str, read_only: bool, disk: Content) -> HostBuffer {
        HostBuffer { project_id: project_id.into(), path: path.into(), text: disk.is_text(), read_only, revision: 0, dirty: false, conflict: None, content: disk.clone(), disk }
    }
    fn limit(&self) -> usize { if self.text { MAX_TEXT_BYTES } else { MAX_BYTES_BYTES } }
    pub fn snapshot(&self) -> (Content, u64) { (self.content.clone(), self.revision) }
    pub fn disk_snapshot(&self) -> Content { self.disk.clone() }
    /// A whole replacement from a panel or the built-in editor; marks the document changed.
    pub fn edit(&mut self, next: Content) -> Result<u64, &'static str> {
        if self.read_only { return Err("ReadOnly"); }
        if next.is_text() != self.text { return Err("InvalidShape"); }
        if next.size() > self.limit() { return Err("LimitExceeded"); }
        if next == self.content { return Ok(self.revision); }
        self.content = next; self.dirty = true; self.revision += 1;
        Ok(self.revision)
    }
    /// The file changed on disk: replaces an unchanged buffer, keeps (and flags) a changed one.
    pub fn disk_changed(&mut self, next: Content) -> DiskOutcome {
        if next == self.disk { return DiskOutcome::Unchanged; }
        if self.dirty { self.conflict = Some(next); return DiskOutcome::Conflict; }
        self.disk = next.clone(); self.content = next; self.revision += 1; self.conflict = None;
        DiskOutcome::Replaced
    }
    /// Drops the unsaved edits and shows the disk content again (the newer one when a conflict is pending).
    pub fn revert(&mut self) -> u64 {
        if let Some(newer) = self.conflict.take() { self.disk = newer; }
        self.content = self.disk.clone(); self.dirty = false; self.revision += 1;
        self.revision
    }
    /// Conflict choice "keep mine": the buffer stays, the newer disk content becomes the baseline.
    pub fn keep_mine(&mut self) { if let Some(newer) = self.conflict.take() { self.disk = newer; } }
    /// The host wrote the buffer to disk.
    pub fn saved(&mut self) { self.disk = self.content.clone(); self.dirty = false; self.conflict = None; }
}

// ---------------------------------------------------------------------------------------------------------------
// The registry: sessions and mounts
// ---------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct Mount { pub id: String, pub project_id: String, pub path: String, pub editor: String, pub owner: Option<String>, pub placement: &'static str, pub failure: Option<&'static str> }
#[derive(Clone, Debug, PartialEq)]
pub struct Audit { pub action: String, pub owner: Option<String>, pub project_id: String, pub path: String, pub revision: u64, pub bytes: usize, pub detail: Option<String> }
#[derive(Clone, Debug)]
pub struct Replace { pub reason: &'static str, pub revision: u64, pub chunks: Vec<Chunk> }

/// Where an audit entry points: project, path, revision.
struct At<'a>(&'a str, &'a str, u64);
struct Session { buffer: HostBuffer, mounts: BTreeMap<String, Mount> }
#[derive(Default)]
struct Inner { sessions: BTreeMap<String, Session>, assemblers: BTreeMap<String, Assembler>, remembered: BTreeMap<String, String>, counter: u64, audit: Vec<Audit>, replaced: BTreeMap<String, Vec<Replace>> }

pub type Source = Arc<dyn Fn() -> Vec<Entry> + Send + Sync>;
/// `(owner, version, permission, project)`: whether the grant is held now.
pub type Gate = Arc<dyn Fn(&str, &str, &str, Option<&str>) -> bool + Send + Sync>;

pub struct DocumentEditors { source: Source, holds: Gate, inner: Mutex<Inner> }
fn key(project: &str, path: &str) -> String { format!("{project}\u{0}{path}") }

impl DocumentEditors {
    pub fn new(source: Source, holds: Gate) -> DocumentEditors { DocumentEditors { source, holds, inner: Mutex::new(Inner::default()) } }
    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> { self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) }
    fn granted(&self, owner: &str, project: &str) -> bool {
        (self.source)().iter().find(|entry| entry.owner == owner).is_some_and(|entry| (self.holds)(owner, &entry.version, PERMISSION, Some(project)))
    }
    fn record(inner: &mut Inner, action: &str, owner: Option<&str>, at: At, bytes: usize, detail: Option<&str>) {
        inner.audit.push(Audit { action: action.into(), owner: owner.map(str::to_owned), project_id: at.0.to_owned(), path: at.1.to_owned(), revision: at.2, bytes, detail: detail.map(str::to_owned) });
    }
    pub fn audit(&self) -> Vec<Audit> { self.inner().audit.clone() }
    pub fn take_replaced(&self, mount: &str) -> Vec<Replace> { self.inner().replaced.remove(mount).unwrap_or_default() }

    /// The editors that may open `path` now (grant checked now).
    pub fn candidates(&self, project: &str, path: &str) -> Vec<Candidate> {
        candidates_for(&(self.source)(), &extension_of(path), &|entry| (self.holds)(&entry.owner, &entry.version, PERMISSION, Some(project)))
    }
    /// "Open with": the editor a file opens in, with the remembered choice applied.
    pub fn select(&self, project: &str, path: &str) -> Selection {
        let remembered = self.inner().remembered.get(&extension_of(path)).cloned();
        select_editor(&self.candidates(project, path), remembered.as_deref())
    }
    /// The user's choice per file type (one editor id, or `builtin`). A choice no candidate backs is refused.
    pub fn remember(&self, project: &str, path: &str, editor: &str) -> Result<(), &'static str> {
        if editor != BUILTIN && !self.candidates(project, path).iter().any(|candidate| candidate.editor.id == editor) { return Err("NotFound"); }
        self.inner().remembered.insert(extension_of(path), editor.to_owned());
        Ok(())
    }
    pub fn remembered_for(&self, path: &str) -> Option<String> { self.inner().remembered.get(&extension_of(path)).cloned() }

    /// Opens (or finds) the host buffer of a file; a second open of the same file shares the buffer.
    pub fn open(&self, project: &str, path: &str, disk: Content, read_only: bool) {
        let mut inner = self.inner();
        inner.sessions.entry(key(project, path)).or_insert_with(|| Session { buffer: HostBuffer::new(project, path, read_only, disk), mounts: BTreeMap::new() });
    }
    pub fn with_buffer<T>(&self, project: &str, path: &str, f: impl FnOnce(&mut HostBuffer) -> T) -> Option<T> {
        self.inner().sessions.get_mut(&key(project, path)).map(|session| f(&mut session.buffer))
    }

    /// Mounts the selected editor in a window or the inspector. A refused grant gives the built-in editor over the same buffer.
    pub fn mount(&self, project: &str, path: &str, editor: &str, placement: &'static str) -> Result<Mount, &'static str> {
        let candidates = self.candidates(project, path);
        let known_package = editor.split('/').next().is_some_and(|package| (self.source)().iter().any(|entry| entry.owner == package) && !self.granted(package, project));
        let mut inner = self.inner();
        inner.counter += 1;
        let id = format!("mount-{}", inner.counter);
        let session = inner.sessions.get_mut(&key(project, path)).ok_or("NotFound")?;
        let text = session.buffer.text;
        let (mut owner, mut chosen, mut failure) = (None, BUILTIN.to_owned(), None);
        if editor != BUILTIN {
            match candidates.iter().find(|item| item.editor.id == editor && (item.editor.encoding == "text") == text) {
                Some(candidate) => { owner = Some(candidate.owner.clone()); chosen = editor.to_owned(); }
                None => failure = Some(if known_package { "grant-revoked" } else { "editor-removed" }),
            }
        }
        let mount = Mount { id: id.clone(), project_id: project.into(), path: path.into(), editor: chosen.clone(), owner: owner.clone(), placement, failure };
        session.mounts.insert(id.clone(), mount.clone());
        let revision = session.buffer.revision;
        if owner.is_some() { inner.assemblers.insert(id, Assembler::new(text)); }
        Self::record(&mut inner, "mount", owner.as_deref(), At(project, path, revision), 0, Some(chosen.as_str()));
        Ok(mount)
    }
    /// Closes a mount (a closed window): a transfer in progress is discarded, the buffer stays while it is changed.
    pub fn unmount(&self, mount_id: &str, keep_session: bool) {
        let mut inner = self.inner();
        inner.assemblers.remove(mount_id);
        let Some(session_key) = inner.sessions.iter().find(|(_, session)| session.mounts.contains_key(mount_id)).map(|(key, _)| key.clone()) else { return };
        let session = inner.sessions.get_mut(&session_key).expect("found above");
        session.mounts.remove(mount_id);
        if !keep_session && session.mounts.is_empty() && !session.buffer.dirty { inner.sessions.remove(&session_key); }
    }
    /// One click between the built-in editor and a package editor: the same buffer, the choice remembered.
    pub fn switch_to(&self, mount_id: &str, editor: &str) -> Result<Mount, &'static str> {
        let mount = self.find(mount_id).ok_or("NotFound")?;
        self.remember(&mount.project_id, &mount.path, editor)?;
        self.unmount(mount_id, true);
        self.mount(&mount.project_id, &mount.path, editor, mount.placement)
    }
    fn find(&self, mount_id: &str) -> Option<Mount> { self.inner().sessions.values().find_map(|session| session.mounts.get(mount_id).cloned()) }
    /// The panel's mount, with the grant checked now; a revoked grant falls the mount back and answers `PermissionDenied`.
    fn panel(&self, mount_id: &str) -> Result<Mount, &'static str> {
        let mount = self.find(mount_id).filter(|mount| mount.owner.is_some() && mount.failure.is_none()).ok_or("NotFound")?;
        if !self.granted(mount.owner.as_deref().unwrap_or_default(), &mount.project_id) { let _ = self.fall_back(mount_id, "grant-revoked"); return Err("PermissionDenied"); }
        Ok(mount)
    }

    /// `pandaView.document.read()`: the whole buffer as chunks.
    pub fn read(&self, mount_id: &str) -> Result<(u64, Vec<Chunk>), &'static str> {
        let mount = self.panel(mount_id)?;
        let mut inner = self.inner();
        let session = inner.sessions.get(&key(&mount.project_id, &mount.path)).ok_or("NotFound")?;
        let (content, revision) = session.buffer.snapshot();
        let chunks = chunk_content(&content, &format!("read-{mount_id}-{revision}"), revision);
        Self::record(&mut inner, "read", mount.owner.as_deref(), At(&mount.project_id, &mount.path, revision), content.size(), None);
        Ok((revision, chunks))
    }
    /// One chunk of `pandaView.document.edit(...)`. `Ok(Some(revision))` when the final chunk was applied.
    pub fn edit(&self, mount_id: &str, chunk: &Chunk) -> Result<Option<u64>, &'static str> {
        let mount = self.panel(mount_id)?;
        let mut inner = self.inner();
        let session_key = key(&mount.project_id, &mount.path);
        let (read_only, revision) = { let session = inner.sessions.get(&session_key).ok_or("NotFound")?; (session.buffer.read_only, session.buffer.revision) };
        if read_only { if let Some(assembler) = inner.assemblers.get_mut(mount_id) { assembler.discard(); } return Err("ReadOnly"); }
        let assembled = inner.assemblers.get_mut(mount_id).ok_or("NotFound")?.accept(chunk, revision)?;
        let Some(content) = assembled else { return Ok(None) };
        let size = content.size();
        let new_revision = inner.sessions.get_mut(&session_key).ok_or("NotFound")?.buffer.edit(content)?;
        Self::record(&mut inner, "edit", mount.owner.as_deref(), At(&mount.project_id, &mount.path, new_revision), size, None);
        Ok(Some(new_revision))
    }
    /// A whole edit from the built-in editor (no wire): the same buffer, so every other view follows.
    pub fn edit_builtin(&self, project: &str, path: &str, content: Content) -> Result<u64, &'static str> {
        let mut inner = self.inner();
        let size = content.size();
        let session = inner.sessions.get_mut(&key(project, path)).ok_or("NotFound")?;
        let revision = session.buffer.edit(content)?;
        Self::record(&mut inner, "edit", None, At(project, path, revision), size, Some("builtin"));
        Ok(revision)
    }
    /// The panel closed mid-transfer: the partial assembly is gone and the buffer is unchanged.
    pub fn abort_transfer(&self, mount_id: &str) { if let Some(assembler) = self.inner().assemblers.get_mut(mount_id) { assembler.discard(); } }

    /// The user's save, or `document.save()`: the host writes the buffer itself through `write`. A pending conflict
    /// refuses with `Conflict` until the user chooses; a failed write keeps the buffer dirty.
    pub fn save(&self, project: &str, path: &str, trigger: &str, write: &dyn Fn(&Content) -> bool) -> Result<u64, &'static str> {
        let (content, revision) = {
            let inner = self.inner();
            let session = inner.sessions.get(&key(project, path)).ok_or("NotFound")?;
            if session.buffer.read_only { return Err("ReadOnly"); }
            if session.buffer.conflict.is_some() { return Err("Conflict"); }
            session.buffer.snapshot()
        };
        if !write(&content) { return Err("HostUnavailable"); }
        let mut inner = self.inner();
        let size = content.size();
        let session = inner.sessions.get_mut(&key(project, path)).ok_or("NotFound")?;
        // Edits that arrived while the write was in flight stay dirty.
        if session.buffer.revision == revision { session.buffer.saved(); }
        Self::record(&mut inner, "save", None, At(project, path, revision), size, Some(trigger));
        Ok(revision)
    }
    /// `pandaView.document.save()` of a panel: the grant is checked now.
    pub fn save_from_panel(&self, mount_id: &str, write: &dyn Fn(&Content) -> bool) -> Result<u64, &'static str> {
        let mount = self.panel(mount_id)?;
        self.save(&mount.project_id, &mount.path, "package", write)
    }

    /// The file changed on disk. An unchanged buffer is replaced and each package mount hears `onDidReplace`.
    pub fn disk_changed(&self, project: &str, path: &str, next: Content) -> DiskOutcome {
        let mut inner = self.inner();
        let size = next.size();
        let Some(session) = inner.sessions.get_mut(&key(project, path)) else { return DiskOutcome::Unchanged };
        let outcome = session.buffer.disk_changed(next);
        match outcome {
            DiskOutcome::Replaced => Self::broadcast(&mut inner, project, path, "disk"),
            DiskOutcome::Conflict => { let revision = inner.sessions[&key(project, path)].buffer.revision; Self::record(&mut inner, "conflict", None, At(project, path, revision), size, None); }
            DiskOutcome::Unchanged => {}
        }
        outcome
    }
    /// Revert: the unsaved edits are dropped on purpose; the mounts hear the replacement with reason `revert`.
    pub fn revert(&self, project: &str, path: &str) -> Result<u64, &'static str> {
        let mut inner = self.inner();
        let revision = inner.sessions.get_mut(&key(project, path)).ok_or("NotFound")?.buffer.revert();
        Self::broadcast(&mut inner, project, path, "revert");
        Ok(revision)
    }
    /// Conflict choices: `keep` leaves the buffer as it is (the next save overwrites the disk), `disk` takes the disk content.
    pub fn resolve_conflict(&self, project: &str, path: &str, keep: bool) -> Result<(), &'static str> {
        let mut inner = self.inner();
        let session = inner.sessions.get_mut(&key(project, path)).filter(|session| session.buffer.conflict.is_some()).ok_or("NotFound")?;
        if keep { session.buffer.keep_mine(); } else { session.buffer.revert(); Self::broadcast(&mut inner, project, path, "disk"); }
        Ok(())
    }
    fn broadcast(inner: &mut Inner, project: &str, path: &str, reason: &'static str) {
        let Some(session) = inner.sessions.get(&key(project, path)) else { return };
        let (content, revision) = session.buffer.snapshot();
        let targets: Vec<String> = session.mounts.values().filter(|mount| mount.owner.is_some() && mount.failure.is_none()).map(|mount| mount.id.clone()).collect();
        for id in targets {
            if let Some(assembler) = inner.assemblers.get_mut(&id) { assembler.discard(); }
            let chunks = chunk_content(&content, &format!("replace-{id}-{revision}"), revision);
            inner.replaced.entry(id).or_default().push(Replace { reason, revision, chunks });
        }
        Self::record(inner, "replace", None, At(project, path, revision), content.size(), Some(reason));
    }

    /// The panel failed (crashed, hung, closed badly): the buffer is untouched and a built-in mount takes its place.
    pub fn panel_failed(&self, mount_id: &str) -> Result<Mount, &'static str> { self.fall_back(mount_id, "panel-failed") }
    /// A grant was revoked or narrowed: every package mount that no longer holds it falls back to the built-in editor.
    pub fn grants_changed(&self) -> Vec<Mount> {
        let stale: Vec<Mount> = self.inner().sessions.values().flat_map(|session| session.mounts.values().cloned()).filter(|mount| mount.owner.is_some() && mount.failure.is_none()).collect();
        stale.into_iter().filter(|mount| !self.granted(mount.owner.as_deref().unwrap_or_default(), &mount.project_id)).filter_map(|mount| self.fall_back(&mount.id, "grant-revoked").ok()).collect()
    }
    fn fall_back(&self, mount_id: &str, reason: &'static str) -> Result<Mount, &'static str> {
        let mut inner = self.inner();
        inner.assemblers.remove(mount_id);
        inner.counter += 1;
        let id = format!("mount-{}", inner.counter);
        let session_key = inner.sessions.iter().find(|(_, session)| session.mounts.contains_key(mount_id)).map(|(key, _)| key.clone()).ok_or("NotFound")?;
        let session = inner.sessions.get_mut(&session_key).expect("found above");
        let old = session.mounts.remove(mount_id).expect("found above");
        let builtin = Mount { id: id.clone(), project_id: old.project_id.clone(), path: old.path.clone(), editor: BUILTIN.into(), owner: None, placement: old.placement, failure: Some(reason) };
        session.mounts.insert(id, builtin.clone());
        let revision = session.buffer.revision;
        Self::record(&mut inner, "fallback", old.owner.as_deref(), At(&old.project_id, &old.path, revision), 0, Some(reason));
        Ok(builtin)
    }
    /// The one entry the rich channel delegates `pandaView.document` to: `{ op: "read" }`, `{ op: "edit", chunk }` and
    /// `{ op: "save" }` of the panel behind `mount_id`, answered as `{ ok: true, ... }` or `{ ok: false, code }`. The
    /// grant is rechecked on every request; `write` is the host's file writer (the panel never writes).
    pub fn handle(&self, mount_id: &str, request: &Value, write: &dyn Fn(&Content) -> bool) -> Value {
        let failed = |code: &str| json!({"ok": false, "code": code});
        match request["op"].as_str() {
            Some("read") => match self.read(mount_id) {
                Ok((revision, chunks)) => {
                    let (text, read_only) = self.find(mount_id).and_then(|mount| self.with_buffer(&mount.project_id, &mount.path, |buffer| (buffer.text, buffer.read_only))).unwrap_or((true, false));
                    json!({"ok": true, "revision": revision, "encoding": if text { "text" } else { "bytes" }, "readOnly": read_only, "chunks": chunks.iter().map(Chunk::json).collect::<Vec<_>>()})
                }
                Err(code) => failed(code),
            },
            Some("edit") => match Chunk::from_json(&request["chunk"]) {
                None => failed("InvalidShape"),
                Some(chunk) => match self.edit(mount_id, &chunk) {
                    Ok(Some(revision)) => json!({"ok": true, "done": true, "revision": revision}),
                    Ok(None) => json!({"ok": true, "done": false}),
                    Err(code) => failed(code),
                },
            },
            Some("save") => match self.save_from_panel(mount_id, write) { Ok(revision) => json!({"ok": true, "revision": revision}), Err(code) => failed(code) },
            _ => failed("InvalidShape"),
        }
    }
    /// The mounts of one file (window and inspector views of the same host buffer).
    pub fn mounts(&self, project: &str, path: &str) -> Vec<Mount> { self.inner().sessions.get(&key(project, path)).map(|session| session.mounts.values().cloned().collect()).unwrap_or_default() }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CASES: &str = include_str!("../../../tests/fixtures/extensions/runtime-document-editors/cases.json");
    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-document-editors/extension.json");
    const RIVAL: &str = include_str!("../../../tests/fixtures/extensions/runtime-document-editors/rival.json");

    /// `"{pad:N}"` anywhere in a fixture stands for N `x` characters.
    fn expand(value: &Value) -> Value {
        match value {
            Value::String(text) => match text.strip_prefix("{pad:").and_then(|rest| rest.strip_suffix('}')).and_then(|count| count.parse::<usize>().ok()) { Some(count) => json!("x".repeat(count)), None => value.clone() },
            Value::Array(items) => Value::Array(items.iter().map(expand).collect()),
            Value::Object(fields) => Value::Object(fields.iter().map(|(key, value)| (key.clone(), expand(value))).collect()),
            other => other.clone(),
        }
    }
    fn cases() -> Value { serde_json::from_str(CASES).unwrap() }
    fn manifest(source: &str) -> Value { serde_json::from_str(source).unwrap() }
    fn base() -> Value { manifest(MANIFEST)["contributes"]["editors"][0].clone() }

    fn refusal_manifest(scripted: &Value) -> Value {
        let mut changed = base();
        if let Some(set) = scripted["set"].as_object() { for (key, value) in set { changed[key] = expand(value); } }
        for key in scripted["drop"].as_array().into_iter().flatten().filter_map(Value::as_str) { changed.as_object_mut().unwrap().remove(key); }
        let mut editors = vec![changed.clone()];
        for extra in scripted["extra"].as_array().into_iter().flatten() {
            let mut more = changed.clone();
            if let Some(set) = extra["set"].as_object() { for (key, value) in set { more[key] = expand(value); } }
            editors.push(more);
        }
        if let Some(count) = scripted["count"].as_u64() {
            editors = (0..count).map(|index| { let mut editor = base(); editor["id"] = json!(format!("sample.notebook/e{index}")); editor }).collect();
        }
        let mut copy = manifest(MANIFEST);
        copy["contributes"]["editors"] = json!(editors);
        if let Some(permissions) = scripted.get("permissions") { copy["permissions"] = permissions.clone(); }
        copy
    }

    #[test]
    fn the_fixture_package_is_valid() {
        let editors = check(&manifest(MANIFEST)).unwrap();
        assert_eq!(editors.iter().map(|editor| editor.id.as_str()).collect::<Vec<_>>(), ["sample.notebook/sql", "sample.notebook/table", "sample.notebook/hex"]);
        assert_eq!(editors[2].encoding, "bytes");
        assert_eq!(check(&manifest(RIVAL)).unwrap().len(), 2);
    }

    #[test]
    fn declaration_refusals_match_the_shared_cases() {
        for case in cases()["refusals"].as_array().unwrap() {
            let refusal = check(&refusal_manifest(case)).unwrap_err();
            let expect = &case["expect"];
            assert_eq!(refusal.code, expect["code"].as_str().unwrap(), "{}", case["id"]);
            assert_eq!(refusal.at, expect["at"].as_str().unwrap(), "{}", case["id"]);
            assert_eq!(json!(refusal.ids), expect["ids"], "{}", case["id"]);
        }
    }

    fn entries(names: &[&str]) -> Vec<Entry> {
        names.iter().map(|name| {
            let source = if *name == "rival" { RIVAL } else { MANIFEST };
            let manifest = manifest(source);
            Entry { owner: manifest["id"].as_str().unwrap().into(), version: "1.0.0".into(), package_name: manifest["name"].as_str().unwrap().into(), editors: check(&manifest).unwrap() }
        }).collect()
    }
    fn registry(names: &'static [&'static str], granted: Arc<Mutex<bool>>) -> DocumentEditors {
        DocumentEditors::new(Arc::new(move || entries(names)), Arc::new(move |_, _, permission, _| permission == PERMISSION && *granted.lock().unwrap()))
    }

    #[test]
    fn selection_matches_the_shared_cases() {
        for case in cases()["selection"].as_array().unwrap() {
            let names: Vec<&str> = case["packages"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
            let candidates = candidates_for(&entries(&names), case["extension"].as_str().unwrap(), &|_| true);
            let selection = select_editor(&candidates, case["remembered"].as_str());
            let mut expect = case["expect"].clone();
            if expect.get("ask").is_none() { expect.as_object_mut().unwrap().remove("ask"); }
            assert_eq!(selection.json(), expect, "{}", case["id"]);
        }
    }

    #[test]
    fn documents_move_in_chunks_of_at_most_192_kib() {
        for case in cases()["chunks"].as_array().unwrap() {
            let size = case["bytes"].as_u64().unwrap() as usize;
            let chunks = if case["encoding"] == "text" { chunk_text(&"x".repeat(size), "t", 0, CHUNK_BYTES) } else { chunk_bytes(&vec![7u8; size], "t", 0, CHUNK_BYTES) };
            assert_eq!(chunks.len(), case["expectChunks"].as_u64().unwrap() as usize, "{}", case["id"]);
            assert!(chunks.iter().all(|chunk| chunk.total_bytes == size), "{}", case["id"]);
            assert!(chunks.last().unwrap().is_final && chunks[..chunks.len() - 1].iter().all(|chunk| !chunk.is_final), "{}", case["id"]);
            let mut assembler = Assembler::new(case["encoding"] == "text");
            let mut done = None;
            for chunk in &chunks { done = assembler.accept(chunk, 0).unwrap(); }
            assert_eq!(done.unwrap().size(), size, "{}", case["id"]);
        }
    }

    #[test]
    fn text_is_cut_at_code_point_boundaries() {
        let text = "é".repeat(5);
        let chunks = chunk_text(&text, "t", 0, 3);
        assert!(chunks.iter().all(|chunk| chunk.data.len() <= 3 && chunk.data.chars().all(|c| c == 'é')));
        assert_eq!(chunks.iter().map(|chunk| chunk.data.as_str()).collect::<String>(), text);
    }

    #[test]
    fn an_interrupted_transfer_is_discarded() {
        let chunks = chunk_text(&"y".repeat(CHUNK_BYTES * 2 + 1), "one", 0, CHUNK_BYTES);
        let mut assembler = Assembler::new(true);
        assert!(assembler.accept(&chunks[0], 0).unwrap().is_none());
        let mut other = chunks[1].clone(); other.transfer = "two".into();
        assert_eq!(assembler.accept(&other, 0).unwrap_err(), "StaleContext");
        assert!(!assembler.is_open());
        assert_eq!(assembler.accept(&chunks[1], 0).unwrap_err(), "InvalidShape");
        let mut stale = Assembler::new(true);
        assert_eq!(stale.accept(&chunks[0], 3).unwrap_err(), "StaleContext");
        let mut wrong = Assembler::new(false);
        assert_eq!(wrong.accept(&chunks[0], 0).unwrap_err(), "InvalidShape");
        let mut big = chunks[0].clone(); big.total_bytes = MAX_TEXT_BYTES + 1;
        assert_eq!(Assembler::new(true).accept(&big, 0).unwrap_err(), "LimitExceeded");
    }

    #[test]
    fn disk_changes_never_lose_unsaved_work() {
        let mut buffer = HostBuffer::new("p1", "a.sql", false, Content::Text("one".into()));
        assert_eq!(buffer.disk_changed(Content::Text("two".into())), DiskOutcome::Replaced);
        assert_eq!(buffer.snapshot().0, Content::Text("two".into()));
        buffer.edit(Content::Text("mine".into())).unwrap();
        assert!(buffer.dirty);
        assert_eq!(buffer.disk_changed(Content::Text("three".into())), DiskOutcome::Conflict);
        assert_eq!(buffer.snapshot().0, Content::Text("mine".into()));
        assert_eq!(buffer.conflict, Some(Content::Text("three".into())));
        buffer.keep_mine();
        assert!(buffer.conflict.is_none() && buffer.dirty);
        buffer.revert();
        assert_eq!(buffer.snapshot().0, Content::Text("three".into()));
        assert!(!buffer.dirty);
    }

    #[test]
    fn read_only_and_limits_refuse_an_edit_and_keep_the_buffer() {
        let mut locked = HostBuffer::new("p1", "a.sql", true, Content::Text("x".into()));
        assert_eq!(locked.edit(Content::Text("y".into())).unwrap_err(), "ReadOnly");
        assert_eq!(locked.snapshot().0, Content::Text("x".into()));
        let mut buffer = HostBuffer::new("p1", "a.sql", false, Content::Text("x".into()));
        assert_eq!(buffer.edit(Content::Text("y".repeat(MAX_TEXT_BYTES + 1))).unwrap_err(), "LimitExceeded");
        assert_eq!(buffer.edit(Content::Bytes(vec![1])).unwrap_err(), "InvalidShape");
        assert!(!buffer.dirty);
    }

    #[test]
    fn a_panel_edits_the_host_buffer_and_a_revoked_grant_falls_back() {
        let granted = Arc::new(Mutex::new(true));
        let editors = registry(&["notebook"], granted.clone());
        editors.open("p1", "q.sql", Content::Text("select 1".into()), false);
        let mount = editors.mount("p1", "q.sql", "sample.notebook/sql", "window").unwrap();
        assert_eq!(mount.owner.as_deref(), Some("sample.notebook"));
        let (revision, chunks) = editors.read(&mount.id).unwrap();
        assert_eq!((revision, chunks.len()), (0, 1));
        let edit = chunk_text("select 2", "e1", revision, CHUNK_BYTES);
        assert_eq!(editors.edit(&mount.id, &edit[0]).unwrap(), Some(1));
        assert_eq!(editors.with_buffer("p1", "q.sql", |buffer| buffer.snapshot().0).unwrap(), Content::Text("select 2".into()));
        // The grant is revoked: the next call is refused, the mount falls back, the unsaved edit is still the host's.
        *granted.lock().unwrap() = false;
        assert_eq!(editors.read(&mount.id).unwrap_err(), "PermissionDenied");
        let mounts = editors.mounts("p1", "q.sql");
        assert_eq!(mounts.len(), 1);
        assert_eq!((mounts[0].editor.as_str(), mounts[0].failure), (BUILTIN, Some("grant-revoked")));
        assert_eq!(editors.edit_builtin("p1", "q.sql", Content::Text("select 3".into())).unwrap(), 2);
        assert!(editors.audit().iter().all(|entry| entry.bytes <= 8));
    }

    #[test]
    fn switching_editors_keeps_one_buffer_and_the_choice_is_remembered() {
        let editors = registry(&["notebook", "rival"], Arc::new(Mutex::new(true)));
        assert_eq!(editors.select("p1", "q.sql").reason, "conflict");
        editors.open("p1", "q.sql", Content::Text("a".into()), false);
        let builtin = editors.mount("p1", "q.sql", BUILTIN, "window").unwrap();
        editors.edit_builtin("p1", "q.sql", Content::Text("b".into())).unwrap();
        let panel = editors.switch_to(&builtin.id, "sample.rival/sql").unwrap();
        assert_eq!(editors.select("p1", "q.sql").editor, "sample.rival/sql");
        assert_eq!(editors.read(&panel.id).unwrap().0, 1);
        let back = editors.switch_to(&panel.id, BUILTIN).unwrap();
        assert_eq!(back.editor, BUILTIN);
        assert_eq!(editors.select("p1", "q.sql").reason, "remembered");
        assert_eq!(editors.switch_to(&back.id, "sample.gone/editor").unwrap_err(), "NotFound");
    }

    #[test]
    fn saving_is_the_hosts_and_a_conflict_blocks_it_until_resolved() {
        let editors = registry(&["notebook"], Arc::new(Mutex::new(true)));
        editors.open("p1", "q.sql", Content::Text("a".into()), false);
        editors.edit_builtin("p1", "q.sql", Content::Text("mine".into())).unwrap();
        assert_eq!(editors.disk_changed("p1", "q.sql", Content::Text("theirs".into())), DiskOutcome::Conflict);
        assert_eq!(editors.save("p1", "q.sql", "user", &|_| true).unwrap_err(), "Conflict");
        editors.resolve_conflict("p1", "q.sql", true).unwrap();
        let written = Mutex::new(None);
        assert_eq!(editors.save("p1", "q.sql", "user", &|content| { *written.lock().unwrap() = Some(content.clone()); true }).unwrap(), 1);
        assert_eq!(written.into_inner().unwrap(), Some(Content::Text("mine".into())));
        assert!(!editors.with_buffer("p1", "q.sql", |buffer| buffer.dirty).unwrap());
    }

    #[test]
    fn replacements_reach_package_mounts_with_their_reason() {
        let editors = registry(&["notebook"], Arc::new(Mutex::new(true)));
        editors.open("p1", "q.sql", Content::Text("a".into()), false);
        let mount = editors.mount("p1", "q.sql", "sample.notebook/sql", "inspector").unwrap();
        assert_eq!(editors.disk_changed("p1", "q.sql", Content::Text("b".into())), DiskOutcome::Replaced);
        editors.edit_builtin("p1", "q.sql", Content::Text("c".into())).unwrap();
        editors.revert("p1", "q.sql").unwrap();
        let replaced = editors.take_replaced(&mount.id);
        assert_eq!(replaced.iter().map(|replace| replace.reason).collect::<Vec<_>>(), ["disk", "revert"]);
        assert_eq!(replaced[1].chunks[0].data, "b");
    }
}
