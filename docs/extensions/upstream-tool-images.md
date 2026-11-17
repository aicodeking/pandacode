# Tool image viewer extras (experimental)

Upstream sync P6 (S0604). PandaCode 0.3.128 added a viewer for images agents viewed
(`src/tool-image-viewer.ts`, styled by `src/tool-images.css`, loaded through `src/tool-images.ts`): it opens fit to
the window with the full image, toggles actual size, steps through every image of the container with the arrow keys
or its buttons, and its header copies the path and reveals the file in the platform's file manager. This page records
how an installed package customizes it, and what stays the viewer's own. With no extension installed, all disabled,
a faulted record or safe mode, the viewer behaves exactly as upstream 0.3.128.

## Decision

The viewer is one more directly mounted dialog (`dialog.showModal()`), so it reuses the owned-dialog band of
[owned-dialogs.md](owned-dialogs.md) instead of a second contract:

- dialog ID `tool-image-viewer` (captured target: the thread the image belongs to) with the two locations
  `panda.dialog.tool-image-viewer.bodyExtras` (owner-labelled plain text) and `panda.dialog.tool-image-viewer.actions`
  (buttons, menu triggers with nested items, status and badge, `showDialog` forms, visibility and order overlays);
- one adapter, `src/extensions/upstream-tool-images.ts`, through the public `attachDialogExtras` seam. The band lives
  inside the viewer's plate under the stage, in the fixed frame the plate already has; while no package contributes
  it is `display: none`, so the frame and focus order are upstream's;
- the main window only: the launcher window loads no extensions and its viewer is unchanged.

Rejected alternatives: a second contract carrying the image path or its bytes (the viewer's image is shown through the
existing `tool_image` command and a package never receives bytes or a way to ask for another image); replacing the
viewer's header buttons (Copy path and Reveal touch the clipboard and the file manager and keep the platform label,
and a replacement would be a second implementation of the same controls); a separate per-image dialog ID.

## What a package gets and what stays the viewer's

| Piece | Owner | Notes |
| --- | --- | --- |
| Notes and secondary actions under the image | package, in the band | owner-labelled, bounded to 8 notes; actions run through the shared action slot |
| Hide, show, reorder and restore of those actions | user, in Settings > Extensions > Surface explorer | the shared layout; "Reset global layout" restores them |
| Close, zoom, previous/next, Copy path, Reveal | the viewer | unchanged, never extension-driven; copy and reveal stay host-run (clipboard, file manager) |
| Loading and authorizing the image | the viewer and native `tool_image` | unchanged; see Image authorization below |

## Captured context and stale actions

The accessory (`dialogAccessory` v1) is captured per opening: window, dialog, mount `tool-image-viewer/<n>`,
revision, task handle (the thread the image belongs to; the project is empty), and target `task`. Each image shown is
its own opening: stepping to another image (button or arrow key) disposes the band and attaches a new one, so the
mount and revision change and an action or reply captured for the previous image is rejected as `StaleContext` and
never acts on the image now shown. Closing disposes the band at once (`Revoked` afterwards); selecting another thread
behind the open viewer changes nothing in the capture; reopening is a new mount. The image path and bytes are never in
the contract. Arrow keys pressed on a band control move between the band's own controls and never step the image;
Escape closes the viewer from anywhere, including the band, and focus returns to the thumbnail that opened it.

## Lifetime and recovery

Disable, uninstall, a faulted package record and safe mode empty or remove only the band: the viewer, the shown image,
its counter, focus and the keyboard stepping stay. An error loading the adapter leaves the viewer complete without its
band. A package needs the declared, listed-at-install `ui.contribute` permission; it is checked where the band draws,
so a package without it contributes nothing (a manifest without the grant does not validate at all).

## Image authorization

Unchanged and not a package concern: the image-authorization boundary is the original project rule that secrets never
reach the webview and automatic network requests need opt-in (`AGENTS.md`, Native and data). `tool_image` serves only
paths the thread's own tool records name, only PNG, JPEG, GIF and WebP within 25 MB, never a network path, and the
bytes reach the webview as a `data:` URL. A package gets no bypass and no extra grant, and nothing in this adapter
restricts a trusted runtime presentation; the contract carries identity, never bytes. Native evidence is
`src-tauri/src/tool_images*.rs` and `tests/upstream-semantic-remote-images.spec.ts` (S04A2), not this page.

## Handoffs

New abilities that need the runtime contracts are named here, never refused for safety:

| Need | Owner |
| --- | --- |
| The image identity (path, size) in the invocation context of a band action | R1004 (tool presentation), consumed by S07C and R1212 |
| Hiding or reordering the viewer's built-in header controls (close, zoom, copy, reveal) | R1004 (tool presentation) |
| Package-provided image content in the viewer (a generated overlay, annotations drawn over the image) | R0203 (content) |

A sync adapter's acceptance here does not claim those later contracts delivered.

## Evidence

Browser fixtures, Chromium and WebKit through the Vite preview, with every native command a preview mock. They are
not installed-WebView acceptance and change no real file, clipboard or task. Tests were written with the code and run
in the final test phase:

- `tests/upstream-tool-images-extensions.spec.ts` with the fixture `tests/fixtures/extensions/upstream-tool-images/manifest.json`,
  installed through Settings > Extensions > Install local package and Enable: the zero-extension viewer, notes and
  actions in the band beside untouched host controls, per-image capture with stale rejection, hide, show and reset,
  keyboard and focus, disable, fault, safe mode and uninstall;
- `tests/extensions-owned-dialogs-coverage.spec.ts` (owned-dialog family test) and `tests/extensions-owned-dialogs.test.mjs`
  (registry, schema, SDK and catalog agree);
- ledger rows `panda.dialog.tool-image-viewer` and `src/tool-image-viewer.ts` in `tests/fixtures/extensions/surfaces.json`.

Playwright ports 16041 (Chromium) and 16042 (WebKit).
