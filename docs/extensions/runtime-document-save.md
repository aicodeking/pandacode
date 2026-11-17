# Saving host buffers through bounded package hooks (runtime slice R0902)

Native owner: `src-tauri/src/extensions/runtime_document_save.rs`. Preview twin: `src/extensions/runtime-document-save.ts`.
Fixtures: `tests/fixtures/extensions/runtime-document-save/` (`extension.json`, the package `sample.sqlfmt` named "SQL
formatter" with an editor and a `save.before` hook; `main.cjs`, its service; `editor/`, its panel; `scenarios.json`, the
saves both folds read; all `synthetic`). Spec: `tests/extensions-runtime-document-save.spec.ts` (preview/Node column).
Native: `runtime_document_save::tests`. It builds on [custom editors and host buffers](runtime-document-editors.md) (R0901)
and the hook chain of [hook resolution](runtime-hook-resolution.md) (R0506).

The host owns the buffer of every open file and is the only writer. This slice is the one path every save takes, whoever
asked, and the delivery of `save.before` that [hook registration](runtime-hook-registration.md) left open. The permission
is `documents.editors`, per project, rechecked natively on every step, revocable and narrowable by the user. A package
that holds it is never asked per action.

```json
"permissions": ["documents.editors", "runtime.service"],
"contributes": { "hooks": [{ "id": "sample.sqlfmt/save", "event": "save.before", "budgetMs": 100, "match": { "extensions": [".sql"] } }] }
```

## Who saves

| Trigger | Where it comes from |
|---|---|
| `user` | the user's save in the built-in editor or a package editor |
| `auto` | an auto-save |
| `package` | `pandaView.document.save()` of a package panel (`SaveFlow::save_from_panel`, grant checked now) |

All three use the host's writer (`DocumentEditors::save`); a panel never writes the file. An unknown trigger answers
`InvalidShape`.

## The order of one save

1. **Checks.** A read-only file answers `ReadOnly` and a pending disk conflict `Conflict`, before any package is asked
   (nothing is formatted for a save that will be refused). The buffer is untouched.
2. **`onWillSave`.** Each package mount of the file is called once to deliver a pending edit; the host waits **at most
   1 s** for each. A callback that throws or is slow never blocks the save (the outcomes `failed` and `timeout` are
   audited).
3. **`save.before`.** For a text buffer, the attached hooks whose `match.extensions` accepts the path (case-insensitive)
   and whose package holds `documents.editors` for the project are asked one after another in the user's package order
   (R0506: each inside its `budgetMs`, 100 to 10,000 ms, all inside 60 s; a package removed meanwhile is skipped, not
   failed). Each receives `{ projectId, path, text, trigger }` with the text the earlier hooks left, and may return
   `{ text }`. It fires for every file the host saves, not only in the package's own editor. A byte buffer has no text and
   asks no hook.
4. **One revision.** The returned text replaces the buffer only if the buffer is still at the revision the chain started
   from. If the user typed meanwhile, the result is late: it is dropped and the newer buffer is what is saved.
5. **Write.** The host writes the buffer. A failed write answers `HostUnavailable` and keeps the buffer dirty; edits
   that arrive while the file is written stay dirty.
6. **Events.** Package mounts hear what happened, in order (below).

## A hook can never refuse a save

| What the hook did | What happens | Receipt |
|---|---|---|
| returns `{ text }` | the text is written (and the buffer shows it) | `applied: true` |
| returns nothing or `{}` | the text is written as it was | none |
| throws, or its service is not running | skipped, text as it was | none; counts toward the failure notice |
| answers after its budget | skipped; the late answer is never applied | `applied: false, Timeout` when it still answers |
| returns an invalid value (an extra key, `text` not a string) | skipped | `applied: false, InvalidShape` |
| returns more than 4 MiB of text | skipped | `applied: false, LimitExceeded` |
| answers for an older revision (the user typed meanwhile) | dropped; the newer buffer is saved | `applied: false, Timeout` |

Three failures in a row of one package's hook give one notice, as for every awaited chain (R0506). `onFailure` is
`continue` for this event: it cannot deny or ask. The user never loses work to a broken package: saving always works.

## What a panel hears

`SaveFlow::drain(mount)` returns the events a package mount has not heard, sorted by revision with a replacement before the
save of the same revision:

| Event | When |
|---|---|
| `replace` with `reason: "format"` | a `save.before` transform changed the buffer |
| `replace` with `reason: "disk"` / `"revert"` | R0901: a disk change while the buffer was unchanged, or a revert |
| `didSave` `{ revision }` | the host wrote the buffer |

A disk replacement and a revert therefore never overtake the save that came before them, and the saved revision never
precedes the formatting that produced it.

## Disable, revoke, uninstall

`SaveFlow::package_gone(owner)`: the hook is removed (a later save does not ask it), the failure streaks go, and every
mount of that package falls back to the built-in editor over the same buffer (`failure: "grant-revoked"`). The unsaved
changes stay the host's and the next save writes them. A panel's `document.save()` on a fallen mount answers `NotFound`;
on a mount whose grant was just revoked, `PermissionDenied` (and the mount falls back).

## Audit

`SaveFlow::audit` records `will-save` (outcome), `save.before` (applied or the refusal code) and `save.before-skipped` with
the package, project, path, revision and size, never the content (ADR-0006). `DocumentEditors::audit` keeps recording the
write itself with the trigger.

## Retained refusals

`ReadOnly` (the file's mode), `Conflict` (protects unsaved work from an overwrite), `InvalidShape` / `LimitExceeded` (the
hook's return and the trigger: stability), `PermissionDenied` (a grant the user revoked), `HostUnavailable` (the write
failed). None is a security measure; a granted package is never withheld a capability.

## Prepared, not run

The wiring of the editor shell and the rich channel to `SaveFlow::save` / `save_from_panel` (replacing the channel's direct
`DocumentEditors::handle` `{ op: "save" }`, and calling `package_gone` where the service lifecycle removes hooks) is a
follow-up of the owners of those files; this slice delivers the host module, its twin, fixtures, scenarios and specs.
Installed-app qualification (a real formatter service saving a real `.sql` file from the built-in editor, a package editor
and an auto-save, with a slow and a throwing handler) is prepared, not run.
