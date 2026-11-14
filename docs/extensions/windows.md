# Auxiliary windows and the native tray menu (experimental)

Declarative packages can target these additional action locations:

| Location | Actual native webview label | Presentation |
| --- | --- | --- |
| `panda.tray.actions` | `tray` | Menu bar popover accessory |
| `panda.tray.menu` | `tray` (OS-menu context) | Native right-click tray menu |
| `panda.launcher.actions` | `launcher` | Quick launcher accessory; this is the overlay |
| `panda.agentsDock.actions` | `agents-dock` | Pinned Running agents window (expanded widget) accessory |

There is no separate `overlay` label and no arbitrary-window registration or window-creation API.
Create a ZIP with `extension.json` and `assets/info.svg` from
`tests/fixtures/extensions/window-laboratory/` at its root. Install and enable it through the main
Extensions page. **Window laboratory → Reports → Choose report format** demonstrates the flow.
`tests/fixtures/extensions/window-coverage/` adds check/radio entries, a passive status and several
native groups to exercise state, hide/order and the host alternatives below.

The three compact webviews use the existing host menu renderer and safe SVG assets. Their forms and
searchable selects open in the existing **main-window** host dialog, which has room for the focus trap
and quick pick. They do not create another privileged webview. The native menu opens its first select
quick pick immediately. Cancelling does not start work; confirming can only display the declared fixed
success message.

## Hide and reorder

Contributions in all four locations hide and reorder from the main Settings → Extensions surface
explorer, like every other action slot. The preference is presentation only: it never grants or revokes
a command, and safe mode applies none of it while keeping it stored.

- The popover, launcher and pinned widget read the shared layout and update in place.
- The OS menu cannot read webview storage. The main window sends it only the **global** hidden IDs and
  order of the top-level `panda.tray.menu` groups through `extensions_native_layout`, a main-only
  command limited to 128 unique package-scoped IDs. Project-scoped layouts do not apply to the OS menu.

## Discover the limitations and fallbacks

`ui.listSurfaces({ windowId: 'tray' })` (and the other actual labels) reports availability per
surface, not a grant. `capabilities` reports `inlineSelect: false`, `selectFallback: 'host-quick-pick'`,
`dialogPlacement: 'main'`, `icons`, `fallbacks`, `limitations` and `qualification: 'experimental'`.
The main Surface explorer displays these capabilities too.

| OS menu control | Native support | Host alternative (`fallbacks`) |
| --- | --- | --- |
| Command, submenu, separator | Yes | — |
| Checkbox / radio | Yes: toolkit check item, state kept for this launch and changed only after the action is authorized | — |
| Package SVG icon | No: OS menus take raster images and package SVG is never rasterized in the native process | `icons → panda.tray.actions` |
| Select, form fields | No inline control | `select → host-quick-pick`, `form → main-dialog` |
| Passive status / badge | Omitted | `status`/`badge → panda.tray.actions` |

The native tree has a 128-item aggregate budget, reserving Open/Recovery/Quit and a diagnostic.
An oversized group is omitted atomically and a disabled, visible overflow diagnostic explains why.
Native capability limitations are not permissions and cannot be bypassed by declaring another label.

## Protected window controls

Each auxiliary window lists its core controls as inspect-only items in its own catalog
(`ui.listItems({ windowId, location })`), each label carrying its reason:

| Location | Window | Items |
| --- | --- | --- |
| `panda.tray.protected` | `tray` | Open PandaCode, Quit, recovery, task rows, plan usage, OS menu icons and inline controls (platform) |
| `panda.launcher.protected` | `launcher` | Close (Escape), recovery, the launcher draft/project/model, native placement |
| `panda.agentsDock.protected` | `agents-dock` | Unpin, Collapse (Escape), agent rows, recovery, pinned window lifetime |

Packages cannot target these locations. The pinned Running agents window opens with **Pin** in the
main-window widget (`panda.roster.controls`) and closes with **Unpin**; its lifetime follows the widget
preference and never owns an agent. Extension-owned rich HTML windows (`extension-view-*`) stay disabled
on every target until installed native isolation qualification exists; the host-rendered view is shown
instead with the reason.

## Authority and lifetime

The native broker derives the caller from the invoking Tauri webview. Auxiliary actions can only
resolve an enabled installed contribution at their own surface and exact package version, with
current ancestor/command conditions. Requests cannot supply window/project/session identity or
arbitrary native commands. Hiding an action does not grant or revoke its command. These narrow
declarative UI adapters do not grant installation, Settings storage, filesystem, process, provider
or workspace command access. Existing host launcher/task controls keep their separate allowlists.

Definitions are shared, UI registrations are not. Closing one secondary window removes only its
UI/listeners; it does not disable the package, close other windows, stop an agent or destroy a draft.
If that window originated a forwarded host form, destruction cancels only that form (including late
presentation replies). Closing another window leaves the form open. Duplicate lifecycle notifications
do not remount unchanged registrations or discard focus/field state.
Disable/recovery removes contributions across open windows and cancels their pending host forms.
The popover and OS menu keep protected Open/Recovery/Quit outside contributed registrations.
Recovery is for the current native launch and retains installation/enabled/layout preferences.

Native Rust tests exercise real package installation and the actual adapter, menu model, check state,
layout and dispatch policy. Browser tests use synthetic IPC and OS-menu event delivery. Neither
constitutes installed Windows/WebView2, macOS/WKWebView, Linux/WebKitGTK or OS-native menu interaction
qualification. This capability remains experimental until those platform checks exist; executable
packages remain unsupported.
