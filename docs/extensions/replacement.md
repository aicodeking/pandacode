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
This is presentation-only declarative support, not an executable component SDK or a composer/
transcript replacement. Browser evidence is not installed native/platform qualification.
