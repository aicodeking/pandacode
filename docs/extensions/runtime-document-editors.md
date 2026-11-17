# Custom editors bound to host buffers (runtime slice R0901)

Native owner: `src-tauri/src/extensions/runtime_document_editors.rs`. Preview twin:
`src/extensions/runtime-document-editors.ts`. Fixtures: `tests/fixtures/extensions/runtime-document-editors/`
(`extension.json`, the package `sample.notebook` named "SQL notebook", with its panel folder `editor/`; `rival.json`, a
second package that also asks for `.sql` as a default; `cases.json`, the refusal, selection and chunk cases both folds
read; all `synthetic`). Spec: `tests/extensions-runtime-document-editors.spec.ts` (preview/Node column). Native:
`runtime_document_editors::tests`.

A package binds file types to a rich panel. The permission is `documents.editors`, per project, rechecked natively on
every read, edit and save, revocable and narrowable by the user. A package that holds it is never asked per action.

```json
"permissions": ["documents.editors"],
"runtime": { "kind": "node", "files": ["editor"] },
"contributes": { "editors": [{
  "id": "sample.notebook/sql", "title": "SQL notebook", "extensions": [".sql"],
  "priority": "default", "encoding": "text", "rich": { "folder": "editor", "entry": "index.html" }
}] }
```

## Declaration

Checked by the schema (shape) and by `runtime_document_editors::check` / `checkEditorDeclarations` (the rest, in this
order, so both validators answer the same first refusal):

| Rule | Refusal |
|---|---|
| id starts with `panda.` | `ReservedId` |
| id does not start with `<package id>/` | `InvalidId` |
| repeated id | `DuplicateId` |
| more than 16 editors | `LimitExceeded` (before the per-editor rules) |
| `title` empty or over 80 characters | `InvalidShape` |
| `extensions` empty, not `^[.][a-z0-9]{1,16}$`, repeated | `InvalidShape` |
| more than 16 `extensions` | `LimitExceeded` |
| `priority` not `default` / `option` (absent: `option`) | `InvalidShape` |
| `encoding` not `text` / `bytes` (absent: `text`) | `InvalidShape` |
| `rich` without `folder` and `entry` | `InvalidShape` |
| `rich.folder` not listed in `runtime.files` | `UnknownReference` |
| `documents.editors` not in `permissions` | `PermissionDenied` (at `permissions`) |

## Which editor opens a file

`select` / `selectEditor`, over the editors of enabled packages whose grant reaches the project:

1. The user's remembered "Open with" choice for the file type wins, the built-in editor included. A remembered editor
   that is gone, disabled or no longer granted is ignored (the next rules apply).
2. One `default` editor opens the file. `option` editors are only offered under "Open with".
3. Two packages asking for `default` for the same type: the built-in editor opens meanwhile and the selection carries
   `reason: "conflict"` and `ask: [ids]`, so the host asks the user once; the answer is remembered.
4. No editor: the built-in editor (`reason: "builtin"`).

The built-in editor is always one click away and so is the way back (`switchTo`): both mounts are views of the same
buffer, so nothing is lost and the choice is remembered per file type.

## The buffer is the host's

`HostBuffer` holds the content of an open file (`projectId`, `path`, `encoding`, `readOnly`, `revision`, `dirty`).
`pandaView.document` is a window onto it:

- `read()` returns the whole buffer; `edit({ text } | { bytes })` replaces it and marks the tab changed; the panel never
  writes the file. `save()` asks the host, which delivers pending edits through `onWillSave` (1 s per callback; a
  failing or slow callback never blocks the save), writes the file itself and replies `onDidSave`.
- A window and the inspector showing the same file share one buffer (keyed by project and path). Closing one keeps a
  changed buffer for the other.
- `onDidReplace({ text | bytes, revision, reason })` follows a change that did not come from the panel:
  `reason: "disk"` (the file changed on disk while the buffer was unchanged) or `"revert"` (the user reverted).
- A disk change while the buffer has unsaved edits changes nothing: the newer disk content is kept aside as a
  conflict. A save is refused with `Conflict` until the user chooses to keep their buffer (the next save overwrites the
  disk) or to take the disk (a replacement with `reason: "disk"`). Revert drops the edits on purpose.
- Read-only files refuse `edit` and `save` with `ReadOnly`; the buffer and reads are untouched.

## Wire form

`ArrayBuffer` exists only in the page API. Between the client script and the host every read, edit and replacement is a
sequence of JSON chunks `{ schemaVersion: 1, transfer, revision, encoding: 'utf8' | 'base64', offset, totalBytes, data,
final }`. `data` holds at most 192 KiB of document bytes (text is cut at a code point boundary; bytes are base64);
text up to 4 MiB and bytes up to 16 MiB (`LimitExceeded` past them; 22 and 86 chunks at the limits). The receiver
assembles in order and acts only on `final: true` with every byte present. Answers: an encoding or shape mismatch or a
gap is `InvalidShape`; a chunk of an older revision than the host's, a second transfer while one is open, and an
interrupted transfer are `StaleContext` and discard the partial assembly, so the buffer is unchanged and the panel
sends it again whole.

## Failure and the way back

A panel that fails (`panelFailed`), a revoked or narrowed grant (`grantsChanged`, and every request) and a removed
editor all end the same way: the panel's mount is replaced by a built-in mount over the same buffer with
`failure: "panel-failed" | "grant-revoked" | "editor-removed"`. The unsaved work is still the host's, so the built-in
editor is usable at once. A request refused for a revoked grant answers `PermissionDenied`.

## Audit

`audit` records `mount`, `read`, `edit`, `save`, `replace`, `conflict` and `fallback` with the package, project, path,
revision and size, never the content. Every action done for a package is labelled with its name by the surface that shows
it.

## Where it mounts

The editor mounts in the original's floating editor window, with the inspector as the fallback (`placement`:
`window` | `inspector`); no second editor shell. The channel of the rich panel (`rich_views::runtime_rich_channel`)
delegates `pandaView.document` to `DocumentEditors::handle` (`{ op: 'read' | 'edit' | 'save' }`).

## Retained refusals (Q093)

The permissioned assertions of this slice are the ones above that now succeed with the grant. These refusals remain and
are not security measures: `PermissionDenied` for a grant the user revoked or narrowed (the user's own control, rechecked
natively); `StaleContext` for a chunk or edit built on an older revision (predictability: a panel never overwrites a
newer buffer blindly); `NotFound` for a mount that is gone or a foreign mount id (a panel only reaches the buffer of the
file it was opened for: fault isolation); `ReadOnly` (the file's mode); `Conflict` (it protects unsaved work from an
overwrite); `LimitExceeded` and `InvalidShape` (stability of the transfer).

## Prepared, not run

Installed-app qualification (the real floating editor window and inspector on the installed Windows build, opening a
real `.sql`, `.csv` and `.bin` file, the real "Open with" menu) is prepared, not run. The wiring of the editor shell and
the channel to `DocumentEditors` is a follow-up of the owners of those files; this slice delivers the host module, its
twin, the contract rules, fixtures and specs.
