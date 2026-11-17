# Edit drafts and attachments without sending (`tasks.draft`)

Runtime phase R4, slice R0403. A trusted background service reads and edits the composer draft of a task, suggests text
as ghost text, attaches and detaches files and reads an attachment in pages, and none of it sends a message. The draft
is the user's text until the user sends it. The permissions are `tasks.draft` (every draft call, attachments included)
and `tasks.transcript.read` (reading an attachment's bytes); both are project scoped, granted with the trust decision,
rechecked natively on every request, revocable and narrowable. A package that holds them is never asked again per action
(ADR-0005).

```js
const draft = await panda.tasks.draft.get({ windowId });            // { text, attachments: [{ id, kind, name }], revision }
await panda.tasks.draft.set({ windowId, text: 'Fix T-12', revision: draft.revision });   // one undo step; never sends
await panda.tasks.draft.insert({ taskId, text: 'also run the linter' });                  // at the caret, one undo step
await panda.tasks.draft.suggest({ windowId, text: ' and add a test' });                    // ghost text
const { id } = await panda.tasks.draft.attach({ taskId, path });                           // { id }
await panda.tasks.draft.detach({ taskId, attachmentId: id });
const page = await panda.tasks.attachments.read({ taskId, attachmentId: id, cursor: 0 });  // 256 KiB base64 per page
```

A target is `{ windowId }` (the draft of the task that window shows) or `{ taskId }`. Exactly one. There is no option, field
or call that sends a message: `send`, `submit` and every unknown field answer `InvalidShape`. Starting a task with a prompt
is `tasks.start` (R0401) and sending to a task is `tasks.message` (R0402); they are different permissions.

| Call | Does |
|---|---|
| `get` | the text, the attachments and the `revision` of the draft |
| `set` | replaces the text (an empty text clears it). With `revision`, a draft that changed since is `StaleContext` |
| `insert` | inserts text at the caret (at the end when the composer is not focused), with a space or a newline when needed |
| `suggest` | draws ghost text beside the prompt; an empty text clears it. Tab at the end of the prompt accepts it as draft text, typing dismisses it |
| `attach` | attaches the file or folder at `path` the way the Attach menu does (an image as an image, a folder as a listing); answers `{ id }` |
| `detach` | removes an attachment of the draft |
| `attachments.read` | one page: `{ schemaVersion: 1, mime, name, bytes, data, nextCursor }`; `cursor` is a byte offset, `data` is base64 of at most 256 KiB decoded, `nextCursor` is null at the end |

`revision` is a hash of the draft's text and attachment ids, so any change by the user or by a package moves it. Reading an
attachment covers both a sent message's attachment (stored natively) and an attachment of an unsent draft (answered by the
window: a file path, or the text of a document or folder listing).

## Where each part runs

- **Native** (`src-tauri/src/extensions/runtime_tasks_drafts.rs`): shape, the frozen refusals, the permission check (before
  the window hears about a task, again for the project the window resolved, and again right before an edit), the pages of
  an attachment, the rounds waiting for the window, and the cleanup. Requests `tasksDraft` and `tasksAttachmentsRead` of
  `node-host.cjs`, served in `runtime_service_lifetime.rs`.
- **Main window** (`src/extensions/runtime-tasks-drafts.ts`, mounted from `src/main.ts`): the composer, its per-task drafts,
  its undo history and the attachment bar live in the window. Every call is two rounds: `resolve` (which task, which
  project, the draft as it is now; nothing changes) and, after the host rechecked the grant for that project, `apply` (the
  edit). The native side emits `extensions-runtime-draft`, the window answers with `extensions_runtime_draft_answer`, and a
  round waits at most 10 s (`Timeout`).
- **Preview twin**: the same file holds `readRequest`, `gate`, `revisionOf` and `DraftModel`, which run the same order of
  checks and edits with no I/O; the browser spec and the preview mock run it. In the browser preview there is no service:
  `window.__runtimeDraft.round(event)` delivers a round and `extensions_runtime_draft_answer` records the answers.

## Order of the refusals (frozen)

1. The permission itself: a package that holds `tasks.draft` for no project at all gets `PermissionDenied` with
   `path: "tasks.draft"` whatever the target, so a refusal never says whether a task or a window exists.
2. The shape: `InvalidShape`, or `LimitExceeded` for a size bound (200,000 bytes of text, 4,096 path characters).
3. The grant for the project: a task by id is gated before the window hears about it; a window target is gated after the
   window resolved the task it shows. A project outside the narrowed scope is `PermissionDenied`.
4. What must exist: an unknown task or window, a window that shows no task, an unknown attachment or an unreadable path is
   `NotFound`.
5. The grant again, just before the edit: a revoke, a narrowing or a disabled package in between edits nothing.
6. The window's `apply`: `StaleContext` when the revision the package gave no longer matches, or when the window now shows
   another task than the one the call resolved; `Busy` while an input method composition is in progress in that composer;
   `Conflict` for an attachment that is already there; `LimitExceeded` for the attachment caps (four images, five
   documents, three folders); `UnsupportedCapability` for a harness that takes no images or a settled task.

A refused call edits no draft, shows no ghost text and attaches nothing.

## What never goes wrong across tasks and windows

- An edit through a window is applied only while that window still shows the task the call resolved. Switching task or
  window between the two rounds is `StaleContext` and changes neither draft.
- Ghost text belongs to the task it was suggested for. Switching what the composer shows, redrawing it for another task,
  the user typing, the package's service ending (disable, revoke, uninstall, safe mode, crash, quit), or a grant that no
  longer holds all take it off the screen at once. A suggestion for a task that is not shown is not kept.
- `set` and `insert` into the shown composer go through the browser's own text editing, so the user's undo returns to the
  text from before the call in one step, and the focus the user had is given back. A draft that is not shown is stored
  through the same per-task draft store the composer uses.
- IME: an edit never lands in the middle of a composition. While the composer composes (`compositionstart` until
  `compositionend`) every edit and `suggest` answers `Busy` and the package retries; `get`, `detach` and the other window
  are untouched. Tab accepts a suggestion only when `isImeKey()` is false.

## The unsent-drafts handoff

`docs/extensions/upstream-recovery.md` lists `unsent-drafts` (Keep unsent drafts, Clear saved drafts) as protected with the
handoff to R0403. What R0403 delivers is the draft contract: a package edits the draft of a task through this permission.
The recovery switch and the irreversible Clear stay the user's host controls (`launch-restore.ts`); a package never
reaches them. Handoff delivered: the draft is reachable through `tasks.draft`, the saved-drafts switch is not.

## Refusal-test reconciliation (Q004, Q006, Q007, Q010, Q070, Q072, Q073, Q076, Q097, Q099, Q100, Q103)

These rows asserted that the composer's attach, tile, slash and bot controls (`draft-write`, `message-send`,
`slash-read-draft`, `slash-send`, the nine attach controls, the ten bot controls) cannot be reached by a package. Mixed
rows are split by operation:

| Operation | Before | Now |
|---|---|---|
| Edit or read a draft, attach, detach, suggest | refused | allowed through `panda.tasks.draft.*` for a package that holds `tasks.draft` for the project; without the grant, narrowed away, revoked or disabled it is still `PermissionDenied` |
| Read an attachment's bytes | refused | allowed through `panda.tasks.attachments.read` under `tasks.transcript.read` |
| A contributed UI action that writes a draft, sends, or sends a slash command (`draft-write`, `message-send`, `slash-send`, `slash-read-draft`) | refused at a protected location | still refused, as a UI action: a contributed control runs on a click the user did not make; a package that wants the effect calls the permissioned API above |
| Send (`message-send`, `slash-send`) | refused | still absent here; sending is `tasks.message` (R0402) |
| Stop, settings and credential changes of a bot (Q103, Q010) | refused | unchanged; they belong to `tasks.control` (R0404) and to the user |
| Forged, stale or foreign-owner requests | refused | unchanged: `StaleContext` and `PermissionDenied` |

Retained refusals and their non-security reasons: unknown task, window or attachment (`NotFound`: nothing to act on), a
revision or a window that moved on (`StaleContext`: the draft is not what the caller read), a composition in progress
(`Busy`: stability of the user's typing), shape and size bounds (input validation, predictability), a cap of eight rounds
waiting per package (fault isolation), the attachment caps (the composer's own limits). The reconciliation of the other
owners' rows (R0402 send and slash, R0404 bot controls, R0406B and R0407 attach and tiles, R0408 console, R1001) is theirs.

## Bounds (predictability and fault isolation, never trust)

Eight rounds per package waiting for the window, 10 s for each answer, 200,000 bytes of text, 4,096 characters of path,
256 KiB per attachment page. A service that ends cancels its waiting rounds: they edit nothing and answer `Revoked`.

## Evidence columns

Preview/model: `tests/extensions-runtime-tasks-drafts.spec.ts` (ports 16251 Chromium, 16252 WebKit). Native unit tests:
`runtime_tasks_drafts::tests`. Fixture package: `tests/fixtures/extensions/runtime-tasks-drafts/`. The installed service
editing a draft through the broker and a real attachment page read is the native column, reported separately.
