# Component presentation v1 (experimental)

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
composer/transcript renderer. Browser evidence is not installed native/platform qualification.
