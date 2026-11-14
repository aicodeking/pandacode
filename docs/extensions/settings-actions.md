# Settings, status, commands, shortcuts and existing-dialog extras

These experimental declarative contributions use the same manifest validator and owner-scoped lifecycle as
header/sidebar actions. The installable `tests/fixtures/extensions/settings-laboratory/extension.json` is the
canonical example (ZIP just `extension.json`; its missing icon uses the documented host fallback).

## Settings

`contributes.settings` declares `{ id, title, fields }`. IDs belong to the package, e.g.
`sample.settings-laboratory/preferences`. Each page gets its own Settings section, roving keyboard navigation,
and searchable `Settings › <title>` deep link; with `section` it is placed as an owner-labelled group in an
eligible core page instead ([settings.md](settings.md)). Fields use the existing text/switch/select grammar, with static
single/multi-select options only; async Settings fields are explicitly rejected. Save is explicit. The native
host validates enabled installation, page ownership, exact field keys, types, limits and allowed option values
on every read/write. These fields cannot read/write PandaCode preference keys or secrets.

Data is stored separately under the app's `extension-settings-v1` directory, per package namespace. Disabled,
uninstalled or safe-mode packages cannot access it. Re-enabling/reinstalling restores compatible values;
incompatible saved values stay dormant and the UI uses declared defaults. Disabling does not erase data.
Executable storage APIs, migrations and stronger quota policy remain later work.

## Status and commands

Use a normal `contributes.menus` entry at `panda.status.items`; it supports the shared icon/button/menu/status/
badge renderer. It appears beside, never replaces, the host update status. No polling is introduced.
All enabled declarative commands are searchable by title and owner in Go to anything. `enabled` on a command
is checked again at invocation. Hiding a menu/control changes presentation, not command authority. Disable,
safe mode and disposal revoke commands; UI conditions are not native operation grants.

## Shortcuts

`contributes.keybindings` contains `{ id, command, key }` with a declared same-owner command and physical
`Mod+[Shift+][Alt+]KeyA-Z` notation (`Mod` is Control or Meta). No unmodified typing keys, chords, input-scope
bindings or arbitrary key-evaluation code are accepted. Settings → Extensions lists all bindings and conflicts.
Conflicts between extensions are unassigned until the user explicitly chooses one. Choices are local UI
preferences and survive reload; missing IDs remain dormant. Core/browser editing shortcuts are reserved and
cannot be taken over. Inputs, editable content, selects, terminals, active IME/keyCode 229, repeats, handled
events and open menus/dialogs never dispatch an extension global shortcut. Commands remain usable via search.

## Existing dialogs: named v1 contracts

Only these hosts opt in; the generic modal has **no** extension insertion hook:

| Host | Named body contract | Named secondary action contract |
| --- | --- | --- |
| Colors | `panda.dialog.colors.bodyExtras` | `panda.dialog.colors.actions` |
| Wallpapers | `panda.dialog.wallpapers.bodyExtras` | `panda.dialog.wallpapers.actions` |

`contributes.dialogExtras` declares `{ id, dialog: "colors" | "wallpapers", text }`. Body extras are bounded
plain text labelled with their owner, not HTML, callbacks or writable core fields. Secondary actions use normal
menu contributions. Host Done, Back, Escape, focus policy and preference handlers stay unchanged. The core
palette also exposes Colors dialog and Wallpapers dialog, using their existing handlers. Close/replacement or
disable disposes contributions and anchored menus. Dialog commands cannot open another modal over an owned one.

Permission, approval, privacy, credential and recovery hosts reject third-party targeting during both native
and frontend manifest validation. They remain reachable through the host's original routes. Other unadopted
dialogs are open implementation work, **not** protected exceptions. These two opted-in hosts each have a
regression fixture in `tests/extensions-settings-actions.spec.ts` and entries in the surface ledger.

Browser preview uses synthetic IPC; native Rust tests exercise real package/settings files. Neither qualifies
installed Windows/WebView2, macOS/WKWebView, Linux/WebKitGTK, real OS IME or native tray/shortcut behavior.
