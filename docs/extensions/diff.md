# Changes presentation v1 (experimental)

## Design and boundary

`panda.changes` is an explicitly selected closed `commit-first` host recipe.
It places the existing commit form ahead of the Changes header, without cloning
the form, file entries, diff workers or selection. Enable is not selection;
conflicts require a user choice in Surface explorer. Failure, disable and safe
mode restore the built-in presentation on the same nodes.

Rejected alternatives: a second diff renderer (loses live layout/selection and
duplicates expensive workers), package DOM/selectors/click proxies (not a public
contract), a new Git mutation service (bypasses existing staged-scope policy), and
inventing hunk staging where the original read-only viewer has none. Hunk/line
mutation is explicitly unsupported, not silently translated into file staging.

## Contract and limits

The manifest declares slot `panda.changes`, version 1, presentation `commit-first`
and capabilities `host-diff`, `host-commit`, `original-actions`. `ui.contribute`
permits declaration; `ui.customize` permits separately selected layout proposals.
No executable Changes service, repository content grant or DOM reference is added.
SDK DTOs document the JSON protocol used by the closed host recipe.

`changesPresentation` captures an opaque window/task/checkout context and repository
identity, monotonically increasing revision, scope, selected/focused handles,
loading/error/offline/visible/pending state, and up to 64 file entries. Each entry
has an opaque file/diff identity, staged side, revision, load state, controls and
up to 32 opaque hunk IDs/revisions (256 across the snapshot). No raw patch, absolute path or selected text
is delivered to packages. Overflow is explicit (`truncated`); the built-in list
is not truncated. Selection is a host-owned opaque handle; line-selection editing
is not enabled in the original viewer. The host remains owner of text selection.

`changesAction` captures context/repository/revision, file/diff/fileRevision,
hunk/hunkRevision (empty/zero for repository or file actions), control ID and a
single-use request ID. Host admission validates owner from the selected provider,
current grant/version/activation, visibility, repository and hunk revisions,
supported enabled controls and pending state before invoking an original handler.
Stable reasons: `InvalidArguments`, `UnsupportedCapability`, `StaleContext`,
`WrongOwner`, `PermissionDenied`, `Revoked`, `Busy`, `AlreadyApplied`.
Admission never retries mutations. Repository switches dispose the old view;
already running operations keep their captured checkout, never the later selection.

## Locations and lifecycle

`panda.changes.actions` accepts ordinary bounded host-rendered contributed actions;
`panda.inspector.changes.context` retains the existing captured file menu.
`panda.changes.controls` exposes scope, fold-all, menu, commit-message, commit and
repository retry; `panda.changes.file` exposes toggle, copy, file-menu and diff retry;
`panda.changes.viewer` exposes original unified/split/wrap controls.
The selected recipe makes the originally hidden inline diff toolbar visible;
no-extension and fallback retain its original hidden inline presentation.
All have stable catalog IDs and host-user visibility/order overlays. Controls
reorder only within compatible siblings. The selected recipe moves the original
commit form, not a new form or a selector supplied by the package. Hiding a
control is not revocation and does not cancel a stage/commit or clear its draft.
The original menu remains a recovery route for stage/unstage/commit/refresh.

Host state changes invalidate captured DTOs; focus-only changes do not reload a
diff. Notifications use the existing extension/layout/component change events,
not polling. Disposal removes owned listeners and contributions, never cancels a
Git operation already dispatched. Load failures retain the original Retry path;
offline disallows new mutations while existing work settles. Binary/large/error
diffs keep the original bounded fallback and controls' actual enabled state.

Package only `tests/fixtures/extensions/diff/extension.json` as a ZIP with
`extension.json` at root (the sibling state/action JSON files are test vectors,
not package assets),
install/enable, then select **Changes presentation → Commit first**. No package
code imports private source or names host selectors. Automated browser and native
package tests are not installed WebView2/WKWebView or native Git qualification.
