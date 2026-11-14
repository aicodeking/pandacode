# Moodboard presentation v1 (experimental)

## Decision

Before v1, the project moodboard library (`src/moodboards.ts`) privately owned the
board list, the selected board, its images and captions, the create form, the delete
confirmation, the image preview, file selection, drop/paste and the Attach to task
button, with no public state, action or replacement contract. v1 adds an explicitly
selected `panda.moodboards` closed `viewer-first` recipe with `host-boards`,
`host-images`, `original-actions`. It moves the original image canvas ahead of the
board library; it does not move the asset store, file selection, drop/paste, image
loading or the attach destination. Arbitrary renderers, selectors, file paths, image
bytes or data URLs, board names or captions as arguments, copied create/add/remove/
attach handlers and public "create" or "confirm delete" actions are rejected: each
would let a package read or write files, choose content for the user, bypass the host
create form or delete confirmation, or attach a board to a draft the user did not
open the library from.

## Contract and policy

`moodboardPresentation` and `moodboardAction` are bounded JSON v1 contracts shared by
the schema, SDK (`MoodboardComponent`, `MoodboardPresentation`, `MoodboardAction`),
native validator and catalog. They capture window, mount, project, selected board,
previewed image and attach destination (the task the library was opened from) as
opaque handles plus a revision; selecting another board, adding, removing or
renaming changes them, so an older request is refused as `StaleContext` instead of
being retargeted. At most 256 eligible controls are returned; the selected board
name requires `projects.summary`. No paths, bytes, data URLs, captions, image names,
credentials, raw IDs, selectors or IPC cross the contract. Loading, busy (an add,
remove, create or delete in flight), error, unsaved draft (create name, board name
or a caption that differs from the saved one), open create form, open delete
confirmation, open preview, attach availability, board and image counts and
truncation are explicit. Metadata is not authority.

Actions require the selected enabled provider and `ui.contribute`, the current
mount/identity/revision, a currently eligible and enabled host control with the
same resource, and replay admission. Rejections use stable reasons: `Revoked`,
`WrongOwner`, `PermissionDenied`, `UnsupportedCapability`, `InvalidArguments`,
`StaleContext`, `AlreadyApplied`, `Busy`. While a board loads or an operation runs,
everything except closing the preview is `Busy`. While a draft is unsaved, only
controls that keep it on screen (`board-new`, `board-rename`, `image-caption`,
`image-preview`, `preview-close`, `delete-cancel`) run; the rest are `Busy`, so a
typed caption or name is never replaced by a redraw. Controls under the open
preview, the user's hidden controls and disabled host buttons are
`UnsupportedCapability`.

`board-new`, `board-rename` and `image-caption` only open or focus the original
form or field: the user types and the host saves. `board-delete` opens the original
confirmation. `image-remove` and `attach` need independent host-user moodboard
control consent, granted from a host button in the library and scoped to the
activation. `image-add`, `image-remove` and `attach` also run only after a fresh host
choice ("Extension requested a moodboard action"): the file chooser opens from that
user gesture, and the attach goes through the original handler, which still checks
that the captured task is current, idle and in the same project, and refuses a board
that is already attached.

## Protected policy

The create submit, the delete confirmation, the file chooser and drop/paste/native
file drop are catalogued in the inspect-only `panda.moodboards.protected` location.
The schema has no `create-confirm`, `delete-confirm`, `file-picker` or `file-drop`
control, so they cannot be forged, invoked or replayed; the protected location is not
a layout location. Discovery, install, enable and selection never read or write a
moodboard. Native moodboard commands, their project scoping, the 12 MB and PNG/JPEG/
WebP limits and the eight-images-per-add and eight-boards-per-message limits are
unchanged.

## Presentation and recovery

`panda.moodboards.controls` catalogs New moodboard, Add images, Delete moodboard and
Attach to task; their order (where they share a row) and reversible visibility are
applied to the original nodes, so listeners, focus and pending work stay.
`panda.moodboards.actions` renders contributed entries in the board toolbar.
`panda.moodboards.context` is the image card and board context menu (right click,
Shift+F10 or the menu key) with the original View image, Edit caption and Remove
image entries plus contributed entries, in the user's order and visibility; it opens
only while a provider is selected or a package contributes there. Conflict never
auto-selects; future contract versions are disabled. Fault, disable and safe mode
restore the built-in layout without reloading the library, re-requesting
thumbnails, closing the preview or forms, changing the selected board, losing a
draft or repeating a pending add, remove, create or delete. Browser fixtures use the
in-memory preview store and a generated one-pixel PNG; they are not installed-native
qualification and use no real or private images.
