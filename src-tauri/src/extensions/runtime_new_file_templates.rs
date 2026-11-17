//! Templated new files and editor selection when a file is revealed (runtime phase R9, slice R0903).
//!
//! * **Declaration.** `contributes.newFiles[]` (`id`, `title`, `extension`, `template`, `editor`) adds an entry to the
//!   new-file menu. [`check`] (called by `contracts.rs`, mirrored by `src/extensions/runtime-new-file-templates.ts`
//!   for `contracts.ts`) applies what the schema cannot say, in this order so both validators answer the same first
//!   refusal: at most 16 items (`LimitExceeded`), ids start with the manifest id plus `/` (`InvalidId`, `ReservedId`
//!   for `panda.`, `DuplicateId`), `title` of at most 80 characters, `extension` `^[.][a-z0-9]{1,16}$`, `template` a
//!   safe archive-relative path (`InvalidShape`) inside a folder listed in `runtime.files` (`UnknownReference`),
//!   `editor` (optional) one of the package's own editors that handles the extension (`UnknownReference`), and the
//!   `documents.editors` permission declared (`PermissionDenied`).
//! * **Creating.** [`NewFiles::create`] is the one path: the item is looked up (`NotFound`/`item`), the project must
//!   still be open (`StaleContext`/`project`), the grant of `documents.editors` for that project is rechecked now
//!   (`PermissionDenied`/`grant`), the path is checked (`InvalidShape`/`path`: relative, no `..`, no drive or
//!   separator tricks, the declared extension appended or kept), the editor is resolved (`NotFound`/`editor`), the
//!   template is read from the package archive (`NotFound`/`template`, `LimitExceeded`, `InvalidShape` for text that is
//!   not UTF-8) and the file is created with create-new semantics (`Conflict`/`file`: an existing file is never
//!   overwritten). Every check runs before the first write, so a refusal creates nothing. The host then opens the
//!   buffer (R0901) and mounts the chosen editor.
//! * **Which editor.** The user's choice at creation (`choice`, `builtin` included) wins over the item's declared
//!   `editor`, which wins over the normal selection of R0901 (`select`). A choice or declaration that names an editor
//!   that is gone, disabled, not granted or does not handle the file type is an explicit `NotFound`/`editor`.
//! * **Reveal.** [`NewFiles::reveal`] is `panda.ui.reveal({ projectId, path, editor })` for a file: the caller holds
//!   `ui.dynamic` (rechecked now), the file is read by the host into the shared buffer, and the editor is the one
//!   named (a package editor needs `documents.editors`, builtin always works) or the normal selection. With every
//!   package disabled or in safe mode the same call opens the built-in editor over the same content.
//! * **Audit.** Records `new-file` and `reveal` with the package, project, path, editor and size, never the content
//!   (ADR-0006). A granted package is never asked per action (ADR-0005); the refusals here protect existing files and
//!   unsaved work (predictability, irreversibility), not the author.
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};

use crate::extensions::runtime_document_editors::{extension_of, valid_extension, Content, DocumentEditors, Gate, Mount, BUILTIN, MAX_BYTES_BYTES, MAX_TEXT_BYTES, MAX_TITLE, PERMISSION};

/// The grant `panda.ui.reveal` needs from its caller (R0206).
pub const DYNAMIC: &str = "ui.dynamic";
pub const MAX_NEW_FILES: usize = 16;
pub const MAX_TEMPLATE_PATH: usize = 256;
pub const MAX_PATH: usize = 512;
const MAX_AUDIT: usize = 4_096;
const AT: &str = "contributes/newFiles";

// ---------------------------------------------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------------------------------------------

/// One `contributes.newFiles[]` entry.
#[derive(Clone, Debug, PartialEq)]
pub struct NewFileDecl { pub id: String, pub title: String, pub extension: String, pub template: String, pub editor: Option<String> }

/// A refused declaration: the error code, the manifest-relative place and the ids it names.
#[derive(Debug, PartialEq, Eq)]
pub struct Refusal { pub code: &'static str, pub at: &'static str, pub ids: Vec<String> }
fn refuse(code: &'static str, at: &'static str, id: &str) -> Refusal { Refusal { code, at, ids: vec![id.to_owned()] } }

fn is_reserved(segment: &str) -> bool {
    let stem = segment.split('.').next().unwrap_or_default().to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit() && stem.as_bytes()[3] != b'0')
}
/// A relative path with `/` separators that cannot leave its root on any platform: no `..`, no empty or `.` segment,
/// no drive letter, backslash, NUL, reserved Windows name or segment ending in a space or a dot.
pub fn valid_relative(path: &str, max: usize) -> bool {
    if path.is_empty() || path.len() > max || path.contains(['\\', '\0']) || path.starts_with('/') { return false; }
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() { return false; }
    path.split('/').all(|segment| {
        !segment.is_empty() && segment != "." && segment != ".." && !segment.ends_with(' ') && !segment.ends_with('.')
            && !segment.contains(['<', '>', ':', '"', '|', '?', '*']) && !segment.chars().any(char::is_control) && !is_reserved(segment)
    })
}

/// The rules of `contributes.newFiles` after the schema checked the shape (same order as `checkNewFileDeclarations`).
pub fn check(manifest: &Value) -> Result<Vec<NewFileDecl>, Refusal> {
    let Some(list) = manifest["contributes"]["newFiles"].as_array().filter(|list| !list.is_empty()) else { return Ok(vec![]) };
    let package = manifest["id"].as_str().unwrap_or_default();
    if list.len() > MAX_NEW_FILES { return Err(refuse("LimitExceeded", AT, package)); }
    let files: BTreeSet<&str> = manifest["runtime"]["files"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let permissions: BTreeSet<&str> = manifest["permissions"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let editors: BTreeMap<&str, Vec<&str>> = manifest["contributes"]["editors"].as_array().into_iter().flatten()
        .filter_map(|editor| Some((editor["id"].as_str()?, editor["extensions"].as_array().into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>()))).collect();
    let (mut ids, mut out) = (BTreeSet::new(), Vec::new());
    for item in list {
        let id = item["id"].as_str().unwrap_or_default();
        if id.starts_with("panda.") { return Err(refuse("ReservedId", AT, id)); }
        if !id.starts_with(&format!("{package}/")) { return Err(refuse("InvalidId", AT, id)); }
        if !ids.insert(id) { return Err(refuse("DuplicateId", AT, id)); }
        let Some(title) = item["title"].as_str().filter(|text| !text.trim().is_empty() && text.chars().count() <= MAX_TITLE) else { return Err(refuse("InvalidShape", AT, id)) };
        let Some(extension) = item["extension"].as_str().filter(|extension| valid_extension(extension)) else { return Err(refuse("InvalidShape", AT, id)) };
        let Some(template) = item["template"].as_str().filter(|template| valid_relative(template, MAX_TEMPLATE_PATH)) else { return Err(refuse("InvalidShape", AT, id)) };
        let folder = template.split('/').next().unwrap_or_default();
        if !template.contains('/') || !files.contains(folder) { return Err(refuse("UnknownReference", AT, id)); }
        let editor = match item.get("editor") {
            None => None,
            Some(value) => {
                let Some(editor) = value.as_str() else { return Err(refuse("InvalidShape", AT, id)) };
                match editors.get(editor) { Some(extensions) if extensions.contains(&extension) => Some(editor.to_owned()), _ => return Err(refuse("UnknownReference", AT, id)) }
            }
        };
        out.push(NewFileDecl { id: id.to_owned(), title: title.to_owned(), extension: extension.to_owned(), template: template.to_owned(), editor });
    }
    if !permissions.contains(PERMISSION) { return Err(refuse("PermissionDenied", "permissions", package)); }
    Ok(out)
}

/// The path a new file gets: `raw` (trimmed) must be a safe relative path; the declared extension is appended when the
/// name has none and kept when it matches (any case); a different extension is refused.
pub fn target_path(raw: &str, extension: &str) -> Result<String, &'static str> {
    let path = raw.trim();
    if !valid_relative(path, MAX_PATH) { return Err("InvalidShape"); }
    let found = extension_of(path);
    if found.is_empty() { let joined = format!("{path}{extension}"); return if valid_relative(&joined, MAX_PATH) { Ok(joined) } else { Err("InvalidShape") }; }
    if found == extension { Ok(path.to_owned()) } else { Err("InvalidShape") }
}

// ---------------------------------------------------------------------------------------------------------------
// The host's seams
// ---------------------------------------------------------------------------------------------------------------

/// What a package contributes to the new-file menu, for the registry.
#[derive(Clone, Debug)]
pub struct Entry { pub owner: String, pub version: String, pub package_name: String, pub items: Vec<NewFileDecl> }
pub type Source = Arc<dyn Fn() -> Vec<Entry> + Send + Sync>;
/// `(owner, version, template path)`: the bytes of a file of the package archive, or `None` when it is not there.
pub type Template = Arc<dyn Fn(&str, &str, &str) -> Option<Vec<u8>> + Send + Sync>;
/// `owner`: does the package hold `ui.dynamic` now?
pub type Dynamic = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// The project's files, owned by the host.
pub trait Project: Send + Sync {
    /// The project is still open and known (a closed or removed one is stale).
    fn known(&self, project: &str) -> bool;
    /// Creates `path` only if it does not exist: `Err("Conflict")` when it does, `Err("StaleContext")` when the
    /// project went away, `Err("HostUnavailable")` for any other failure. Parent folders are created.
    fn create_new(&self, project: &str, path: &str, content: &Content) -> Result<(), &'static str>;
    /// The file's bytes and whether it is read-only: `Err("NotFound")`, `Err("StaleContext")`, `Err("HostUnavailable")`.
    fn read(&self, project: &str, path: &str) -> Result<(Vec<u8>, bool), &'static str>;
}

#[derive(Clone)]
pub struct Env { pub source: Source, pub holds: Gate, pub dynamic: Dynamic, pub template: Template, pub files: Arc<dyn Project> }

/// A failure with its code and the part that failed (`item`, `project`, `grant`, `path`, `editor`, `template`, `file`, `request`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure { pub code: &'static str, pub what: &'static str }
fn fail(code: &'static str, what: &'static str) -> Failure { Failure { code, what } }
impl Failure { pub fn json(&self) -> Value { json!({"ok": false, "code": self.code, "what": self.what}) } }

#[derive(Clone, Debug, PartialEq)]
pub struct Audit { pub action: &'static str, pub owner: Option<String>, pub project_id: String, pub path: String, pub editor: String, pub bytes: usize }

/// A created file with the editor it opened in.
#[derive(Clone, Debug)]
pub struct Created { pub project_id: String, pub path: String, pub item: String, pub owner: Option<String>, pub editor: String, pub reason: &'static str, pub bytes: usize, pub mount: Mount }
impl Created {
    pub fn json(&self) -> Value {
        json!({"ok": true, "projectId": self.project_id, "path": self.path, "item": self.item, "owner": self.owner, "editor": self.editor, "reason": self.reason, "bytes": self.bytes, "mount": self.mount.id, "placement": self.mount.placement, "failure": self.mount.failure})
    }
}
/// A revealed file with the editor it opened in.
#[derive(Clone, Debug)]
pub struct Opened { pub project_id: String, pub path: String, pub owner: Option<String>, pub editor: String, pub reason: &'static str, pub mount: Mount }
impl Opened {
    pub fn json(&self) -> Value {
        json!({"ok": true, "projectId": self.project_id, "path": self.path, "owner": self.owner, "editor": self.editor, "reason": self.reason, "mount": self.mount.id, "placement": self.mount.placement, "failure": self.mount.failure})
    }
}

/// `text` is `Some(true)` for a text editor, `Some(false)` for a bytes editor and `None` for the built-in one, which
/// shows UTF-8 as text and anything else as bytes. `Err` is `InvalidShape` (text that is not UTF-8) or `LimitExceeded`.
fn content_for(bytes: Vec<u8>, text: Option<bool>) -> Result<Content, &'static str> {
    let content = match text {
        Some(true) => Content::Text(String::from_utf8(bytes).map_err(|_| "InvalidShape")?),
        Some(false) => Content::Bytes(bytes),
        None => match String::from_utf8(bytes) { Ok(text) => Content::Text(text), Err(error) => Content::Bytes(error.into_bytes()) },
    };
    let limit = if matches!(content, Content::Text(_)) { MAX_TEXT_BYTES } else { MAX_BYTES_BYTES };
    if content.size() > limit { Err("LimitExceeded") } else { Ok(content) }
}

/// Which editor opens a file and how the choice was made. `Err` is the explicit failure.
fn resolve(editors: &DocumentEditors, project: &str, path: &str, wanted: Option<(&str, &'static str)>) -> Result<(String, &'static str, Option<bool>), Failure> {
    match wanted {
        Some((BUILTIN, reason)) => Ok((BUILTIN.to_owned(), reason, None)),
        Some((id, reason)) => {
            let candidate = editors.candidates(project, path).into_iter().find(|candidate| candidate.editor.id == id).ok_or_else(|| fail("NotFound", "editor"))?;
            Ok((candidate.editor.id.clone(), reason, Some(candidate.editor.encoding == "text")))
        }
        None => {
            let selection = editors.select(project, path);
            let text = editors.candidates(project, path).into_iter().find(|candidate| candidate.editor.id == selection.editor).map(|candidate| candidate.editor.encoding == "text");
            Ok((selection.editor, "selected", text))
        }
    }
}

/// The new-file menu and the creation of its files, plus the editor choice of `ui.reveal`.
pub struct NewFiles { env: Env, audit: Mutex<Vec<Audit>> }
impl NewFiles {
    pub fn new(env: Env) -> NewFiles { NewFiles { env, audit: Mutex::new(Vec::new()) } }
    fn audit_log(&self) -> std::sync::MutexGuard<'_, Vec<Audit>> { self.audit.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) }
    pub fn audit(&self) -> Vec<Audit> { self.audit_log().clone() }
    fn record(&self, entry: Audit) {
        let mut log = self.audit_log();
        if log.len() >= MAX_AUDIT { log.drain(..MAX_AUDIT / 2); }
        log.push(entry);
    }

    /// The items of the new-file menu for a project: packages that are enabled and hold `documents.editors` there,
    /// ordered by package and id, each labelled with its package's name.
    pub fn menu(&self, project: &str) -> Vec<Value> {
        let mut rows: Vec<(String, String, Value)> = (self.env.source)().iter().filter(|entry| (self.env.holds)(&entry.owner, &entry.version, PERMISSION, Some(project))).flat_map(|entry| {
            entry.items.iter().map(|item| (entry.owner.clone(), item.id.clone(), json!({"id": item.id, "owner": entry.owner, "package": entry.package_name, "title": item.title, "extension": item.extension, "editor": item.editor})))
        }).collect();
        rows.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
        rows.into_iter().map(|row| row.2).collect()
    }

    /// Creates the file of a menu item and opens it. `choice` is the user's editor for this file (an editor id or
    /// `builtin`); it wins over the item's declared editor. Nothing is written unless every check passed.
    pub fn create(&self, editors: &DocumentEditors, project: &str, item: &str, name: &str, choice: Option<&str>, placement: &'static str) -> Result<Created, Failure> {
        let entries = (self.env.source)();
        let (entry, decl) = entries.iter().find_map(|entry| entry.items.iter().find(|decl| decl.id == item).map(|decl| (entry, decl))).ok_or_else(|| fail("NotFound", "item"))?;
        if !self.env.files.known(project) { return Err(fail("StaleContext", "project")); }
        if !(self.env.holds)(&entry.owner, &entry.version, PERMISSION, Some(project)) { return Err(fail("PermissionDenied", "grant")); }
        let path = target_path(name, &decl.extension).map_err(|code| fail(code, "path"))?;
        let wanted = match (choice, decl.editor.as_deref()) { (Some(editor), _) => Some((editor, "override")), (None, Some(editor)) => Some((editor, "declared")), (None, None) => None };
        let (editor, reason, text) = resolve(editors, project, &path, wanted)?;
        let bytes = (self.env.template)(&entry.owner, &entry.version, &decl.template).ok_or_else(|| fail("NotFound", "template"))?;
        let content = content_for(bytes, text).map_err(|code| fail(code, "template"))?;
        self.env.files.create_new(project, &path, &content).map_err(|code| match code {
            "Conflict" => fail("Conflict", "file"),
            "StaleContext" => fail("StaleContext", "project"),
            _ => fail("HostUnavailable", "file"),
        })?;
        let size = content.size();
        editors.open(project, &path, content, false);
        let mount = editors.mount(project, &path, &editor, placement).map_err(|code| fail(code, "editor"))?;
        self.record(Audit { action: "new-file", owner: Some(entry.owner.clone()), project_id: project.into(), path: path.clone(), editor: mount.editor.clone(), bytes: size });
        Ok(Created { project_id: project.into(), path, item: item.into(), owner: mount.owner.clone(), editor: mount.editor.clone(), reason, bytes: size, mount })
    }

    /// `panda.ui.reveal({ projectId, path, editor })` for a file. `caller` is the package that asked (`None` for the
    /// host's own navigation); its `ui.dynamic` grant is rechecked now. The file is read by the host and shares the
    /// buffer of any window already showing it.
    pub fn reveal(&self, editors: &DocumentEditors, caller: Option<&str>, project: &str, path: &str, editor: Option<&str>, placement: &'static str) -> Result<Opened, Failure> {
        if let Some(owner) = caller { if !(self.env.dynamic)(owner) { return Err(fail("PermissionDenied", "grant")); } }
        if !valid_relative(path, MAX_PATH) { return Err(fail("InvalidShape", "path")); }
        if !self.env.files.known(project) { return Err(fail("StaleContext", "project")); }
        let (id, reason, text) = resolve(editors, project, path, editor.map(|editor| (editor, "chosen")))?;
        let open = editors.with_buffer(project, path, |buffer| buffer.text);
        let text_buffer = match open {
            Some(text_buffer) => text_buffer,
            None => {
                let (bytes, read_only) = self.env.files.read(project, path).map_err(|code| match code {
                    "NotFound" => fail("NotFound", "file"),
                    "StaleContext" => fail("StaleContext", "project"),
                    _ => fail("HostUnavailable", "file"),
                })?;
                let content = content_for(bytes, text).map_err(|code| fail(code, "file"))?;
                let text_buffer = matches!(content, Content::Text(_));
                editors.open(project, path, content, read_only);
                text_buffer
            }
        };
        // An editor that cannot show this content (a text editor over bytes, or the other way round) is named, not guessed.
        if let Some(wants_text) = text { if wants_text != text_buffer { return Err(fail("InvalidShape", "editor")); } }
        let mount = editors.mount(project, path, &id, placement).map_err(|code| fail(code, "editor"))?;
        let size = editors.with_buffer(project, path, |buffer| buffer.snapshot().0.size()).unwrap_or(0);
        self.record(Audit { action: "reveal", owner: caller.map(str::to_owned), project_id: project.into(), path: path.into(), editor: mount.editor.clone(), bytes: size });
        Ok(Opened { project_id: project.into(), path: path.into(), owner: mount.owner.clone(), editor: mount.editor.clone(), reason, mount })
    }

    /// The one entry the host's IPC and the rich channel delegate to: `{ op: "menu", projectId }`,
    /// `{ op: "create", projectId, item, name, editor? }` and `{ op: "reveal", projectId, path, editor? }`, answered as
    /// `{ ok: true, ... }` or `{ ok: false, code, what }`. Grants are rechecked on every call.
    pub fn handle(&self, editors: &DocumentEditors, request: &Value, caller: Option<&str>) -> Value {
        let text = |key: &str| request[key].as_str();
        let placement: &'static str = if request["placement"] == "inspector" { "inspector" } else { "window" };
        let Some(project) = text("projectId") else { return fail("InvalidShape", "request").json() };
        let result = match request["op"].as_str() {
            Some("menu") => return json!({"ok": true, "items": self.menu(project)}),
            Some("create") => match (text("item"), text("name")) {
                (Some(item), Some(name)) => self.create(editors, project, item, name, text("editor"), placement).map(|created| created.json()),
                _ => Err(fail("InvalidShape", "request")),
            },
            Some("reveal") => match text("path") {
                Some(path) => self.reveal(editors, caller, project, path, text("editor"), placement).map(|opened| opened.json()),
                None => Err(fail("InvalidShape", "request")),
            },
            _ => Err(fail("InvalidShape", "request")),
        };
        result.unwrap_or_else(|failure| failure.json())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::runtime_document_editors::{check as check_editors, Entry as EditorEntry};
    use std::sync::atomic::{AtomicBool, Ordering};

    const CASES: &str = include_str!("../../../tests/fixtures/extensions/runtime-new-file-templates/cases.json");
    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-new-file-templates/extension.json");
    const OWNER: &str = "sample.notes";

    fn expand(value: &Value) -> Value {
        match value {
            Value::String(text) => match text.strip_prefix("{pad:").and_then(|rest| rest.strip_suffix('}')).and_then(|count| count.parse::<usize>().ok()) { Some(count) => json!("x".repeat(count)), None => value.clone() },
            Value::Array(list) => Value::Array(list.iter().map(expand).collect()),
            Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), expand(item))).collect()),
            other => other.clone(),
        }
    }

    /// The fixture manifest with one case applied to its first new-file item.
    fn build(case: &Value) -> Value {
        let mut manifest: Value = serde_json::from_str(MANIFEST).expect("manifest");
        let base = manifest["contributes"]["newFiles"][0].clone();
        let derive = |changes: &Value| {
            let mut item = base.clone();
            for (key, value) in changes["set"].as_object().into_iter().flatten() { item[key] = expand(value); }
            for key in changes["drop"].as_array().into_iter().flatten().filter_map(Value::as_str) { item.as_object_mut().expect("item").remove(key); }
            item
        };
        let mut list = vec![derive(case)];
        for extra in case["extra"].as_array().into_iter().flatten() { list.push(derive(extra)); }
        if let Some(count) = case["count"].as_u64() { list = (0..count).map(|index| { let mut item = base.clone(); item["id"] = json!(format!("{OWNER}/n{index}")); item }).collect(); }
        manifest["contributes"]["newFiles"] = Value::Array(list);
        if let Some(permissions) = case.get("permissions") { manifest["permissions"] = permissions.clone(); }
        manifest
    }

    #[test]
    fn declarations_refuse_in_the_shared_order() {
        let cases: Value = serde_json::from_str(CASES).expect("cases");
        for case in cases["refusals"].as_array().expect("refusals") {
            let refusal = check(&build(case)).expect_err(case["id"].as_str().unwrap_or_default());
            assert_eq!(refusal.code, case["expect"]["code"].as_str().unwrap(), "{}", case["id"]);
            assert_eq!(refusal.at, case["expect"]["at"].as_str().unwrap(), "{}", case["id"]);
            let ids: Vec<&str> = case["expect"]["ids"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
            assert_eq!(refusal.ids.iter().map(String::as_str).collect::<Vec<_>>(), ids, "{}", case["id"]);
        }
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        assert_eq!(check(&manifest).expect("fixture manifest is valid").len(), 3);
        assert_eq!(check(&json!({"id": OWNER})).expect("no newFiles"), vec![]);
    }

    #[test]
    fn paths_are_safe_and_carry_the_declared_extension() {
        for good in ["a", "dir/a", "dir/a.note", "A.NOTE", " padded "] { assert!(target_path(good, ".note").is_ok(), "{good}"); }
        assert_eq!(target_path("dir/a", ".note").unwrap(), "dir/a.note");
        assert_eq!(target_path("A.NOTE", ".note").unwrap(), "A.NOTE");
        for bad in ["", "..", "../a", "a/../b", "/abs", "C:/a", "c:a", "a\\b", "a//b", "./a", "a/", "CON", "dir/nul.note", "a.sql", "a?", "a\0b", "trailing."] { assert_eq!(target_path(bad, ".note"), Err("InvalidShape"), "{bad:?}"); }
        assert!(valid_relative("templates/empty.note", MAX_TEMPLATE_PATH));
        assert!(!valid_relative(&"a".repeat(MAX_PATH + 1), MAX_PATH));
    }

    #[derive(Default)]
    struct Disk { files: Mutex<BTreeMap<String, Vec<u8>>>, stale: AtomicBool, read_only: AtomicBool }
    impl Project for Disk {
        fn known(&self, _project: &str) -> bool { !self.stale.load(Ordering::SeqCst) }
        fn create_new(&self, _project: &str, path: &str, content: &Content) -> Result<(), &'static str> {
            let mut files = self.files.lock().unwrap();
            if files.contains_key(path) { return Err("Conflict"); }
            files.insert(path.to_owned(), match content { Content::Text(text) => text.clone().into_bytes(), Content::Bytes(bytes) => bytes.clone() });
            Ok(())
        }
        fn read(&self, _project: &str, path: &str) -> Result<(Vec<u8>, bool), &'static str> { self.files.lock().unwrap().get(path).cloned().map(|bytes| (bytes, self.read_only.load(Ordering::SeqCst))).ok_or("NotFound") }
    }

    struct State { grant: AtomicBool, dynamic: AtomicBool, editors_gone: AtomicBool, template_missing: AtomicBool }
    struct Rig { editors: DocumentEditors, flow: NewFiles, disk: Arc<Disk>, state: Arc<State> }

    fn rig(existing: &[&str]) -> Rig {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        let items = check(&manifest).unwrap();
        let declared = check_editors(&manifest).unwrap();
        let state = Arc::new(State { grant: AtomicBool::new(true), dynamic: AtomicBool::new(true), editors_gone: AtomicBool::new(false), template_missing: AtomicBool::new(false) });
        let disk = Arc::new(Disk::default());
        for path in existing { disk.files.lock().unwrap().insert((*path).to_owned(), b"old".to_vec()); }
        let holds_state = state.clone();
        let holds: Gate = Arc::new(move |_owner, _version, permission, _project| holds_state.grant.load(Ordering::SeqCst) && permission == PERMISSION);
        let editor_state = state.clone();
        let editor_source: crate::extensions::runtime_document_editors::Source = Arc::new(move || {
            let editors = if editor_state.editors_gone.load(Ordering::SeqCst) { vec![] } else { declared.clone() };
            vec![EditorEntry { owner: OWNER.into(), version: "1.0.0".into(), package_name: "Notes".into(), editors }]
        });
        let editors = DocumentEditors::new(editor_source, holds.clone());
        let (dynamic_state, template_state) = (state.clone(), state.clone());
        let env = Env {
            source: Arc::new(move || vec![Entry { owner: OWNER.into(), version: "1.0.0".into(), package_name: "Notes".into(), items: items.clone() }]),
            holds,
            dynamic: Arc::new(move |_owner| dynamic_state.dynamic.load(Ordering::SeqCst)),
            template: Arc::new(move |_owner, _version, path| if template_state.template_missing.load(Ordering::SeqCst) { None } else { match path { "templates/empty.note" => Some(b"# New note\n".to_vec()), "templates/blank.dat" => Some(b"DAT1\n".to_vec()), _ => None } }),
            files: disk.clone(),
        };
        Rig { editors, flow: NewFiles::new(env), disk, state }
    }

    #[test]
    fn creating_follows_the_shared_flows() {
        let cases: Value = serde_json::from_str(CASES).expect("cases");
        for case in cases["flows"].as_array().expect("flows") {
            let id = case["id"].as_str().unwrap_or_default();
            let existing: Vec<&str> = case["existing"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
            let rig = rig(&existing);
            rig.state.grant.store(case["grant"].as_bool().unwrap_or(true), Ordering::SeqCst);
            rig.state.editors_gone.store(case["editorGone"].as_bool().unwrap_or(false), Ordering::SeqCst);
            rig.state.template_missing.store(case["templateMissing"].as_bool().unwrap_or(false), Ordering::SeqCst);
            rig.disk.stale.store(case["staleProject"].as_bool().unwrap_or(false), Ordering::SeqCst);
            let before = rig.disk.files.lock().unwrap().clone();
            let request = json!({"op": "create", "projectId": "p1", "item": case["item"], "name": case["name"], "editor": case.get("choice").cloned().unwrap_or(Value::Null)});
            let answer = rig.flow.handle(&rig.editors, &request, None);
            let expect = &case["expect"];
            if expect["ok"] == true {
                assert_eq!(answer["ok"], true, "{id}: {answer}");
                assert_eq!(answer["path"], expect["path"], "{id}");
                assert_eq!(answer["editor"], expect["editor"], "{id}");
                assert_eq!(answer["reason"], expect["reason"], "{id}");
                assert_eq!(answer["bytes"], expect["bytes"], "{id}");
                let written = rig.disk.files.lock().unwrap().get(expect["path"].as_str().unwrap()).cloned().expect("file created");
                assert_eq!(String::from_utf8(written).unwrap(), expect["content"].as_str().unwrap(), "{id}");
                assert!(rig.editors.with_buffer("p1", expect["path"].as_str().unwrap(), |buffer| buffer.text == (expect["encoding"] == "text")).unwrap_or(false), "{id}");
            } else {
                assert_eq!(answer["ok"], false, "{id}: {answer}");
                assert_eq!(answer["code"], expect["code"], "{id}");
                assert_eq!(answer["what"], expect["what"], "{id}");
                assert_eq!(*rig.disk.files.lock().unwrap(), before, "{id}: a refusal creates nothing");
            }
        }
    }

    #[test]
    fn reveal_follows_the_shared_cases() {
        let cases: Value = serde_json::from_str(CASES).expect("cases");
        for case in cases["reveals"].as_array().expect("reveals") {
            let id = case["id"].as_str().unwrap_or_default();
            let rig = rig(&[]);
            for (path, text) in case["files"].as_object().into_iter().flatten() { rig.disk.files.lock().unwrap().insert(path.clone(), text.as_str().unwrap().as_bytes().to_vec()); }
            rig.state.dynamic.store(case["dynamic"].as_bool().unwrap_or(true), Ordering::SeqCst);
            rig.state.editors_gone.store(case["editorGone"].as_bool().unwrap_or(false), Ordering::SeqCst);
            let request = json!({"op": "reveal", "projectId": "p1", "path": case["path"], "editor": case.get("editor").cloned().unwrap_or(Value::Null)});
            let answer = rig.flow.handle(&rig.editors, &request, Some(OWNER));
            let expect = &case["expect"];
            if expect["ok"] == true {
                assert_eq!(answer["ok"], true, "{id}: {answer}");
                assert_eq!(answer["editor"], expect["editor"], "{id}");
                assert_eq!(answer["reason"], expect["reason"], "{id}");
            } else {
                assert_eq!(answer["code"], expect["code"], "{id}: {answer}");
                assert_eq!(answer["what"], expect["what"], "{id}");
            }
        }
    }

    #[test]
    fn create_save_disable_and_reopen_keeps_the_content() {
        let rig = rig(&[]);
        let created = rig.flow.create(&rig.editors, "p1", "sample.notes/note", "notes/today", None, "window").expect("created");
        assert_eq!(created.editor, "sample.notes/note");
        // The panel edits the host buffer; the host saves it to the project's file.
        rig.editors.edit_builtin("p1", &created.path, Content::Text("# New note\n\nedited".into())).unwrap();
        let disk = rig.disk.clone();
        rig.editors.save("p1", &created.path, "user", &|content| { disk.files.lock().unwrap().insert(created.path.clone(), match content { Content::Text(text) => text.clone().into_bytes(), Content::Bytes(bytes) => bytes.clone() }); true }).expect("saved");
        // The package goes away (disabled, safe mode): the file reopens in the built-in editor with the saved text.
        rig.state.editors_gone.store(true, Ordering::SeqCst);
        let fresh = DocumentEditorsAfterRestart::open(&rig, &created.path);
        assert_eq!(fresh.0, "builtin");
        assert_eq!(fresh.1, "# New note\n\nedited");
    }

    /// A restart: a new registry (no open buffers) over the same disk and the same disabled package.
    struct DocumentEditorsAfterRestart;
    impl DocumentEditorsAfterRestart {
        fn open(rig: &Rig, path: &str) -> (String, String) {
            let restarted = rig_editors_like(rig);
            let opened = rig.flow.reveal(&restarted, Some(OWNER), "p1", path, None, "window").expect("reopened");
            let text = restarted.with_buffer("p1", path, |buffer| match buffer.snapshot().0 { Content::Text(text) => text, Content::Bytes(_) => String::new() }).unwrap();
            (opened.editor, text)
        }
    }
    fn rig_editors_like(rig: &Rig) -> DocumentEditors {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        let declared = check_editors(&manifest).unwrap();
        let state = rig.state.clone();
        let source: crate::extensions::runtime_document_editors::Source = Arc::new(move || {
            let editors = if state.editors_gone.load(Ordering::SeqCst) { vec![] } else { declared.clone() };
            vec![EditorEntry { owner: OWNER.into(), version: "1.0.0".into(), package_name: "Notes".into(), editors }]
        });
        let holds: Gate = Arc::new(|_owner, _version, permission, _project| permission == PERMISSION);
        DocumentEditors::new(source, holds)
    }

    #[test]
    fn the_menu_lists_granted_items_only() {
        let rig = rig(&[]);
        let items = rig.flow.menu("p1");
        assert_eq!(items.len(), 3);
        assert!(items.iter().all(|item| item["package"] == "Notes"));
        rig.state.grant.store(false, Ordering::SeqCst);
        assert!(rig.flow.menu("p1").is_empty());
    }
}
