# Document presentation v1 (experimental)

## Design and boundary

`panda.documents` is an explicitly selected `viewer-first` component recipe. It
places the original document toolbar after the live viewer, retaining the real tab
strip, controls, keyboard handlers and viewer nodes. Enable alone does not select
a provider. Competing providers require a user choice in Surface explorer.

Package the contents of `tests/fixtures/extensions/documents/` as a local ZIP
with `extension.json` at its root. Install and enable it in Settings → Extensions,
then select **Document presentation → Viewer first** in Surface explorer. The
fixture also offers **Attach before copy**, a separately selected `ui.customize`
proposal. No executable trust or runtime entrypoint is involved in this recipe.

Rejected alternatives: a second viewer would lose PDF workers, sheet selection,
reader position and asynchronous ownership; selector/click APIs would expose private
implementation rather than a contract; executable render callbacks would unnecessarily
cross the HTML/process boundary. This is a closed host-rendered recipe, not an
executable documents service or permission to read document bytes.

## Contract

The manifest declares `slot: "panda.documents"`, `contractVersion: 1`,
`presentation: "viewer-first"` and capabilities `host-tabs`, `host-viewer`,
`original-actions`. `ui.contribute` permits declaration, not automatic selection.
The SDK's DocumentPresentation DTO is immutable and bounded (1,000 tabs, 256
controls). Host-generated tab and document IDs survive presentation changes;
paths are never accepted as action targets. Context identifies the captured
window/task/workspace, revision changes on tab/content/control changes, selection
and focus are host-owned handles. No DOM, bytes, native IPC or credential crosses
this contract.

Actions capture contract version, context, revision, tab ID, document ID and
control ID. Original open/select/close/attach/copy/preview and reader view/wrap,
sheet selection and image zoom handlers remain core-owned. Availability is
advertised per live control; PDF and Word have no invented editing controls.
Unsupported, malformed/forged, stale and revoked calls return distinct reasons.
An instance is revoked on disposal or provider/version/activation change. It
never resolves a later selected tab. A revision gap requires a fresh snapshot.

## Lifecycle and fallback

### Public catalog locations

| Location | Original host controls / supported operation |
| --- | --- |
| `panda.documents.navigation` | Open files / Close open files; visibility and sibling order, without implicit document close |
| `panda.documents.tabs` | Select / Close on each original tab; visibility and sibling control order |
| `panda.documents.actions` | Attach / Copy / Preview plus contributed buttons and menus; visibility/order |
| `panda.documents.context` | Captured tab's original actions plus contributed menu entries; visibility/order |
| `panda.documents.viewer` | Rendered / Raw / Wrap, the sheet-selection group or image Actual size; visibility and compatible sibling order |
| `panda.documents` | Explicit recipe selection and host-node view placement (`panda.views/documents`) between Main and Inspector / compatible host docks |

Layout proposals can target these control locations, but only the action/context
slots accept menu contributions. Per-control selection (`selected`) is projected
from original pressed state. Actions use a bounded single-tab/control projection,
so DTO limits do not impose a new limit on built-in open tabs or spreadsheet sheets.
The recipe receives no content; this contract does not add an executable SDK
`documents` service, arbitrary document writes or viewer editing controls.

Host updates state after original actions; focus-only changes do not recreate the
viewer. Replacement, visibility/order and compatible movement must never call a
viewer renderer. Built-in recovery removes the recipe attribute only. Faults are
latched per installed provider identity; disable and safe mode restore built-in
presentation without closing documents. Actual tab/content changes retain the
original host disposal policy. Cache limits, file parsing/sanitization and platform
limits remain unchanged. Native installed UI qualification is deferred, not passed.
