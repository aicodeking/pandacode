# Component presentation v1 (experimental)

Document tabs and live viewers have their own [document presentation v1](documents.md)
contract (`panda.documents`); `panda.files` below is the Files tree, not a document viewer.

The [Board presentation v1](board.md) contract (`panda.board`) offers an explicitly
selected `review-first` host recipe, bounded captured task actions and independent
host-user task-control consent. It never replaces task lifecycle or the core editor.

The [Pull request presentation v1](pull.md) contract (`panda.pull`) offers an explicitly
selected `tabs-first` host recipe over the original Pull inspector. Merge confirmation
and its method select stay host-owned and have no public action.

The [Branch and worktree presentation v1](worktree.md) contract (`panda.worktree`) offers an
explicitly selected `controls-first` host recipe over the composer branch chip. The create form
submit and the cleanup confirmation stay host-owned and have no public action.

The [Moodboard presentation v1](moodboards.md) contract (`panda.moodboards`) offers an
explicitly selected `viewer-first` host recipe over the project moodboard library. The create
submit, delete confirmation, file chooser and drop stay host-owned and have no public action.

The [Cloud machine presentation v1](cloud.md) contract (`panda.cloud`) offers an explicitly
selected `controls-below` host recipe over a cloud task's status strip. The provisioning send,
provider credentials and the delete confirmation stay host-owned and have no public action.

The [Execution target and machine coordination presentation v1](machines.md) contract
(`panda.machines`) offers an explicitly selected `controls-below` host recipe over the orchestration
slot. Remote starts, the behind-GitHub continue, pairing, link and access consent stay host-owned and
have no public action.

Install the `tests/fixtures/extensions/replacement` package as a local archive. In Settings →
Extensions → Surface explorer choose **Project presentation** or **File presentation** explicitly.
Enable alone does not replace anything. Competing providers never win by installation order.
Choose **Built-in** at any time; the Settings keyboard shortcut and safe mode remain available.

`contributes.components` entries declare an owner-scoped `id`, `title`, `slot` (`panda.projects`
or `panda.files`), integer `contractVersion` and `presentation` (`cards` or `list`). Version 1
uses host-rendered, escaped text and existing design tokens; there is no package DOM, JavaScript
renderer, callback or IPC handle. Unsupported versions stay dormant, with built-in recovery.

The internal `ComponentSlot<TProps, TActions, TState>` boundary holds deeply frozen JSON props:
context/revision, objects with ID/label/revision, directory expansion/depth, and host selection,
focus, visibility, loading/offline state. Actions are exactly version/context/revision, object ID/
revision and `select`, `open`, or `toggle`. Project select delegates to the existing project handler;
file open and folder toggle delegate to the existing file services. Unsupported actions, unknown
objects, stale revisions, hidden/loading/offline instances and disposed instances are rejected.

Updates dispose the previous instance/listeners; hidden views revoke dispatch. Selection/folder
expansion/file tabs remain core-owned. Built-in recovery never rewrites drafts, streams, PTYs or
task selection. A rendering exception quarantines that provider identity until its package changes
or the app restarts. Preferences retain dormant IDs across disable/uninstall; selecting Built-in
clears the preference. Persistence schema is `{schemaVersion:1,selected:{[slot]:providerId}}`.
## Composer presentation v1 (experimental)

The `tests/fixtures/extensions/composer` package offers `panda.composer` with the
`toolbar-first` presentation. Install and enable it, then explicitly choose **Composer
presentation** in the Surface explorer. It places the existing model/mode/tools tray
above the input; all host controls remain available, including voice, attachments,
queue/steering, approvals, Send and Stop. Styles load with the host on first render.

Design decision: use a closed declarative presentation recipe rather than a second
editor, arbitrary renderer callbacks or an executable composer service. Cloning or
serializing the editor loses browser-native IME/undo state; duplicating send handlers
risks double submission and approval/grant bypass. This recipe changes only host CSS
and attributes. The input, listeners, focus/selection, attachment store, queue and
business handlers remain host-owned. No DOM reference or draft/credential payload is
returned to package code, and this slot introduces no task-control or approval API.

Version 1 requires all capabilities: `host-input`, `attachments`, `model-mode`,
`queue-steer`, `send-stop`, `approvals`. Missing/unknown capabilities, unsupported
presentation or slot versions disable selection with a reason. These declarations
select a tested host recipe, not permission grants or self-certified custom editors.
Disable, safe mode, Built-in selection and a host presentation failure remove the
recipe without rendering or replacing the editor. A failed provider identity stays
quarantined until package change or restart. The same conformance scenarios run
against Built-in and the installed alternate package, with typing/streaming recovery.

This remains declarative support, not an executable component SDK or arbitrary
composer renderer. Browser evidence is not installed native/platform qualification.

## Transcript and trace presentation v1 (experimental)

Install `tests/fixtures/extensions/transcript` and explicitly select **Transcript
presentation → Timeline transcript**. `panda.transcript` accepts only `timeline`
and all capabilities: `streaming`, `tool-output`, `questions`, `approvals`,
`team-progress`, `usage`, `stop-resume`, `host-history`. This is a closed host
recipe, not an executable renderer or a content-read endpoint. It decorates the
existing normalized host turn/trace nodes without replacing them or parsing CLI
output. Every core action, message ID, selection, follow/scroll intent, stream
and completion handler stays in the host, including questions/approval bars and
the composer Stop/continue workflow. Recipe changes never subscribe to events.

`ui.contribute` authorizes registration only. Separate `tasks.transcript.read`
and `tasks.tools.read` permissions are required to apply this content-bearing
recipe. Missing either shows an explicit unsupported/content-redacted status;
the complete built-in remains active so required actions are not hidden. No
content or DOM handle is sent to package code even with both permissions.
These supported-API permissions do not sandbox independently trusted executable
code's ordinary OS access. Disable/uninstall, safe mode, Built-in and controlled
host rendering failure immediately restore the undecorated host transcript.
Failure quarantine is scoped to provider identity. Native/platform interactive
qualification remains deferred; automated browser conformance is not that proof.
