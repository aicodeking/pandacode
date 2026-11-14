# Design presentation v1 (experimental)

## Decision and boundary

Use the explicitly selected `panda.design` closed `comments-first` host recipe,
requiring `host-artboards`, `host-comments`, `original-actions`. It changes the
original comments region's CSS order, never reparents an iframe, remounts the
canvas or copies a business handler. Arbitrary renderers, DOM/selector APIs and
raw HTML/frame access were rejected: they break the existing script-free frame
boundary and lose live selection or drafts. Toolbar-only customization was
rejected because state, original actions and continuity are also required.

`designPresentation` and `designAction` are bounded JSON-only v1 contracts shared
by SDK, TypeScript and native schema validation. Context, project/task, artboard,
comment and selection handles are captured; resources have opaque host revisions.
Every action repeats context/revision/selection and its target's revision.
Foreign, stale, revoked, wrong-owner, ungranted, busy and replayed requests fail
closed. No selector, HTML, path, frame, comment text, draft text or raw native IPC
is exported. Artboard labels require the independent `projects.summary`
declaration; comment status and host-owned draft presence are metadata only.

## Actions and lifetime

Pan uses four bounded direction tokens; zoom uses original in/out/fit handlers.
Select accepts bounded artboard coordinates and delegates the original host
element picker (not a selector or arbitrary frame command). Comment mode, cancel,
draft focus, save, resolve, reopen, delete, reload and compose use the original
controller. Save reads the live host form, not package text. Compose only puts
the original prompt in the composer; it never sends. The original UI has no
delete confirmation; no new bypass is introduced. A save in flight is serialized,
context-bound and never retargets the current project. Failed saves retain draft
and selection; input arriving during a save is retained as the next draft.
If the picked artboard changes, save is disabled until a fresh host selection;
the old draft remains visible, never silently saved against a changed document.

`panda.design.controls` catalogs every original operation, with reversible
visibility and compatible sibling order. `panda.design.actions` and
`panda.design.context` use shared contributed buttons/menus and captured context.
Compatible movement means original comments-before-viewport visual placement;
arbitrary canvas docking is not offered. Hide intentionally detaches artboard
frames, as before; presentation movement/recovery does not. View, selection and
drafts remain in the original controller across either lifecycle.

Package `tests/fixtures/extensions/design/` as a ZIP with `extension.json` at its
root; install/enable in Extensions, then explicitly choose **Design presentation**
in Surface explorer. Installation and conflicts never select a provider. Built-in,
fault, disable and safe-mode recovery preserve the same live controller/nodes.
Browser preview tests are synthetic evidence, not installed native WebView or
device qualification. Native archive/schema tests are identified separately.
