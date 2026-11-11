# UI discovery (experimental, declarative v1)

Settings → Extensions → **Surface explorer** lists the same copied JSON DTOs as the
host's read-only `ui.listSurfaces(query)` and `ui.listItems(query)` adapters. This is
host-side discovery infrastructure, not an executable SDK, native RPC endpoint or
permission to call internal application services. No executable extension host is enabled.

## Metadata and stable identities

Every record has `id`, `owner`, `type`, `location`, `label`, `supportedOperations`
and `available`. Surfaces additionally advertise `supportedItemTypes` and `windows`.
Contributed items include the package version. IDs do not depend on DOM placement,
load order, activation generation or reload. Public data contains no nodes, selectors,
callbacks, SVG source, business-state objects or raw IPC handles. Changing a returned
object cannot change the registry.

The currently adopted logical families are `panda.workspace.header.actions` and
`panda.sidebar.footer`. Header discovery includes the existing leading sidebar toggle
and responsive workspace-view menu; footer discovery includes Help, usage, Settings,
Star and theme. Responsive relocation of Help/usage/view controls does not rename their
logical location. The action dock is a separate inventoried family, **not** implicitly
made public by its proximity to the header. Only buttons can currently be contributed.
Existing menu triggers are discoverable built-ins, not new contribution kinds.

`inspect` means metadata, `contribute` means the implemented declarative button adapter,
and `invoke` means an explicitly public core UI command. Hide/order/move/replace are not
advertised before those adapters exist. Visibility is not authorization.

## Queries and unavailable locations

Both methods accept exact `owner`, `type`, `location` and `windowId` filters plus
`limit` (integer 1–100, default 50) and `cursor`. Records sort lexically by stable ID.
Responses are `{ schemaVersion: 1, revision, items, nextCursor }`. Cursors are opaque,
bounded and tied to the method, filters, page size, catalog instance and revision.
Keep query options unchanged on the next page. A changed catalog or filter returns
`StaleContext`; restart without a cursor. Reload creates a new instance/cursor lifetime
but preserves record IDs. Invalid arguments return `InvalidQuery`. No arbitrary offset
or unlimited response is accepted.

A nonexistent exact location filter returns an empty page. **Required manifest menu
locations** must be one of the two supported IDs; the shared manifest schema rejects
unknown locations atomically (`InvalidShape`), rather than half-activating a package.
There is currently no optional-location manifest syntax: optional consumers discover a
location by querying it and omit their optional UI when the result is empty or unavailable.
Do not treat an unknown required location as an optional no-op. Unknown optional API
capabilities continue to produce the existing validation diagnostics; they do not create
new locations or grant operations.

The current adapters run only in the main window. Querying `tray`, `launcher`, headless,
an unknown or closed/unavailable window returns discoverable definitions marked
`available: false, reason: "HostUnavailable"`; `windows: ["main"]` states the supported
family. This is not a live OS window enumeration. No main-window authority is inherited
by another window. Unsupported windows never receive contribution instances here.

## Public commands and unchanged business behavior

Only these host UI commands are explicitly registered at this stage:

| Command | Original handler | Arguments/precondition |
|---|---|---|
| `panda.ui/toggle-sidebar` | `toggleSidebar()` | `null`, main window |
| `panda.ui/open-settings` | `showSettings()` | `null`, main window |
| `panda.ui/toggle-theme` | `toggleTheme()` | `null`, main window |

Metadata carries their null input schema, `host.ui` capability and supported main
context. The host-only command adapter rejects unknown IDs (`NotFound`), non-null
arguments (`InvalidArguments`) and other windows (`HostUnavailable`) before calling
exactly the existing handler once, with zero business arguments. Original failures
propagate. The explorer's Run buttons are explicit trusted host gestures; **packages
cannot invoke these commands through a menu declaration or metadata query**. Core
support, usage, Star and anchored menus remain private (inspect only). No duplicate
business handler, synthetic click, direct IPC passthrough or extension authorization
bypass is introduced. Future broker/SDK exposure must add its own schema and policy
boundary; this host adapter is not evidence of such authorization.

Disable, corrupt-package recovery and safe mode remove contributed metadata/controls
but leave built-in discovery and its protected Settings route usable. No layout, task,
draft, PTY or database migration is part of discovery. Installed native UI qualification
remains separate from headless browser/JSON tests.
