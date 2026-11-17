# Templated new files and the editor of a revealed file (runtime slice R0903)

Native owner: `src-tauri/src/extensions/runtime_new_file_templates.rs`. Preview twin:
`src/extensions/runtime-new-file-templates.ts`. Fixtures: `tests/fixtures/extensions/runtime-new-file-templates/`
(`extension.json`, the package `sample.notes` named "Notes" with three editors and three new-file items; `editor/`, its
panel folder; `templates/`, the archive files the items copy; `cases.json`, the refusal, flow and reveal cases both folds
read; all `synthetic`). Spec: `tests/extensions-runtime-new-file-templates.spec.ts` (preview/Node column). Native:
`runtime_new_file_templates::tests`.

This slice closes the document loop of R9 over the host buffers of R0901 and the save path of R0902: a package adds
entries to the new-file menu, the host creates the file from a template of the package archive and opens it in the chosen
editor, and `panda.ui.reveal` for a file picks the editor the same way. It uses the permission `documents.editors`, per
project, rechecked natively on every call, revocable and narrowable by the user. A package that holds it is never asked
per action. Revealing also needs the caller's `ui.dynamic` grant (R0206).

```json
"permissions": ["documents.editors"],
"runtime": { "kind": "node", "files": ["editor", "templates"] },
"contributes": {
  "editors": [{ "id": "sample.notes/note", "title": "Note editor", "extensions": [".note"], "priority": "default",
                "encoding": "text", "rich": { "folder": "editor", "entry": "index.html" } }],
  "newFiles": [{ "id": "sample.notes/note", "title": "New note", "extension": ".note",
                 "template": "templates/empty.note", "editor": "sample.notes/note" }]
}
```

## Declaration

Checked by the schema (shape) and by `runtime_new_file_templates::check` / `checkNewFileDeclarations` (the rest, in this
order, so both validators answer the same first refusal):

| Rule | Refusal |
|---|---|
| more than 16 items | `LimitExceeded` (before the per-item rules) |
| id starts with `panda.` | `ReservedId` |
| id does not start with `<package id>/` | `InvalidId` |
| repeated id | `DuplicateId` |
| `title` empty or over 80 characters | `InvalidShape` |
| `extension` not `^[.][a-z0-9]{1,16}$` | `InvalidShape` |
| `template` not a safe relative path (see below) or over 256 characters | `InvalidShape` |
| `template` outside a folder, or its folder not listed in `runtime.files` | `UnknownReference` |
| `editor` present but not a string | `InvalidShape` |
| `editor` not one of the package's own editors, or one that does not handle `extension` | `UnknownReference` |
| `documents.editors` not in `permissions` | `PermissionDenied` (at `permissions`) |

A safe relative path uses `/`, has no empty, `.` or `..` segment, no leading `/`, drive letter, backslash, NUL or control
character, no Windows-reserved character or name (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`) and no segment ending
in a space or a dot. The `editor` of an item is optional: without one the file opens in the normal selection of R0901.

## Creating a file

`NewFiles::create(project, item, name, choice?, placement)` / `NewFiles.create(...)` is the one path. Its checks run in
this order and every one runs before the first write, so a refusal creates nothing. The answer is `{ ok: false, code,
what }`, where `what` names the part that failed.

| Step | Failure (`code` / `what`) |
|---|---|
| the item is not offered by an enabled package | `NotFound` / `item` |
| the project is closed or gone | `StaleContext` / `project` |
| `documents.editors` held for that project now | `PermissionDenied` / `grant` |
| `name` (trimmed) is a safe relative path; the declared extension is appended when it has none and kept when it matches (any case); any other extension is refused | `InvalidShape` / `path` |
| the editor: the user's `choice` (`builtin` included) wins over the item's declared `editor`, which wins over the selection of R0901; a named editor that is gone, disabled, not granted or does not handle the type | `NotFound` / `editor` |
| the template file of the archive | `NotFound` / `template` |
| the template as the editor's encoding (a text editor needs UTF-8; the built-in editor shows UTF-8 as text, anything else as bytes); 4 MiB text, 16 MiB bytes | `InvalidShape` or `LimitExceeded` / `template` |
| the write has create-new semantics; an existing file is never overwritten | `Conflict` / `file` |
| the project went away during the write | `StaleContext` / `project` |
| any other write failure | `HostUnavailable` / `file` |

After the write the host opens the buffer (R0901 `open`, the file is the baseline, nothing dirty) and mounts the editor
in the floating editor window (`placement: "window"`, or the inspector). The result carries the path, the editor and why
(`reason`: `declared`, `override` or `selected`), the size and the mount. A file that was created stays: if the mount then
falls back (a panel that fails) the built-in editor shows the same buffer.

## Revealing a file

`NewFiles::reveal(caller, project, path, editor?, placement)` is `panda.ui.reveal({ projectId, path, editor })` for a file.
Order: the caller's `ui.dynamic` (`PermissionDenied` / `grant`), a safe path (`InvalidShape` / `path`), an open project
(`StaleContext` / `project`), the editor, then the file (`NotFound` / `file`). The editor is the named one (`reason:
"chosen"`; a package editor needs `documents.editors` and to handle the type, else `NotFound` / `editor`; `builtin` always
works) or the normal selection (`reason: "selected"`: the remembered "Open with" choice, one default, the built-in editor).
A text editor over a file that is not UTF-8 text, or a bytes editor over text, is `InvalidShape` / `editor`. A file already
open shares its host buffer, so a window and the inspector show unsaved edits together.

With every package disabled, uninstalled or in safe mode, the same call opens the built-in editor over the same content:
nothing is lost, because the saved file is on disk and an unsaved buffer is the host's (R0902 `package_gone` takes the
mounts of a package that goes away back to the built-in editor).

## The one entry

`NewFiles::handle(editors, request, caller)` / `NewFiles.handle(...)` is what the host IPC and the rich channel delegate to:
`{ op: "menu", projectId }` answers `{ ok: true, items }` (enabled, granted items, ordered by package and id, each labelled
with the package name); `{ op: "create", projectId, item, name, editor? }` and `{ op: "reveal", projectId, path, editor? }`
answer `{ ok: true, ... }` or `{ ok: false, code, what }`. A request without a project, an operation or its fields is
`InvalidShape` / `request`.

## Audit

`new-file` and `reveal` record the package, project, path, editor and size, never the content (ADR-0006). Every action done
for a package is labelled with its name by the surface that shows it.

## Retained refusals (Q093)

These are not security measures (ADR-0005). `PermissionDenied` is the user's own control, rechecked natively on every call;
`StaleContext` is a project that no longer exists; `Conflict` protects an existing file from an overwrite (irreversible);
`NotFound` names the part that is missing instead of guessing; `InvalidShape` / `path` keeps every path inside the project
on every platform; `LimitExceeded` is the stability limit of the buffer. Nothing is asked of a package that holds the grant.

## Prepared, not run

Installed-app qualification on Windows is prepared, not run: install the `sample.notes` fixture, choose "New note" from the
new-file menu and see `today.note` open in the Note editor with the template text; create the same item with the override
to the built-in editor; edit, save with the user's save and reopen the file; disable the package (and start in safe mode) and
reopen: the built-in editor shows the saved text; try an existing name and see the `Conflict` message without any change;
reveal the file from a service with and without an `editor`. Both Playwright engines run the preview spec. The wiring of the
new-file menu entry in the original's file dialog, of `panda.ui.reveal` (`runtime_dialog_navigation.rs`) and of the IPC to
`NewFiles::handle` belongs to the owners of those files; this slice delivers the host module, its twin, the contract rules,
fixtures and specs.
