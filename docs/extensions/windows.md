# Auxiliary windows and the native tray menu (experimental)

Declarative packages can target these additional action locations:

| Location | Actual native webview label | Presentation |
| --- | --- | --- |
| `panda.tray.actions` | `tray` | Menu bar popover accessory |
| `panda.tray.menu` | `tray` (OS-menu context) | Native right-click tray menu |
| `panda.launcher.actions` | `launcher` | Quick launcher accessory; this is the overlay |
| `panda.agentsDock.actions` | `agents-dock` | Expanded running-agents widget accessory |

There is no separate `overlay` label and no arbitrary-window registration or window-creation API.
Create a ZIP with `extension.json` and `assets/info.svg` from
`tests/fixtures/extensions/window-laboratory/` at its root. Install and enable it through the main
Extensions page. **Window laboratory → Reports → Choose report format** demonstrates the flow.

The three compact webviews use the existing host menu renderer and safe SVG assets. Contributions
can be hidden/reordered within their logical slot. Their forms and searchable selects open in the
existing **main-window** host dialog, which has room for the focus trap and quick pick. They do not
create another privileged webview. The native menu opens its first select quick pick immediately.
Cancelling does not start work; confirming can only display the declared fixed success message.

## Discover the limitations

`ui.listSurfaces({ windowId: 'tray' })` (and the other actual labels) reports availability per
surface, not a grant. `capabilities` reports `inlineSelect: false`, `selectFallback: 'host-quick-pick'`,
`dialogPlacement: 'main'`, `icons`, `limitations` and `qualification: 'experimental'`.
The main Surface explorer displays these capabilities too.

Native menus accept command actions/submenus/separators. They cannot render package SVG icons,
inline selects or passive status/badges. Check/radio entries are plain command actions without
inline checked state; webview menus retain their normal checked-state behavior. Native visibility/
order overlays are unsupported. Validated manifest ordering (`order`/`before`/`after`) still applies.
The native tree has a 128-item aggregate budget, reserving Open/Recovery/Quit and a diagnostic.
An oversized group is omitted atomically and a disabled, visible overflow diagnostic explains why.
Native capability limitations are not permissions and cannot be bypassed by declaring another label.

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
Recovery is for the current native launch and retains installation/enabled preferences.

Native Rust tests exercise real package installation and the actual adapter/dispatch policy. Browser
tests use synthetic IPC and OS-menu event delivery. Neither constitutes installed Windows/WebView2,
macOS/WKWebView, Linux/WebKitGTK or OS-native menu interaction qualification. This capability remains
experimental until those platform checks exist; executable packages remain unsupported.
