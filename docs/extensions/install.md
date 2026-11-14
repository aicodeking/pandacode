# Local declarative extensions (experimental)

The action adapters add host-rendered `showMessage` and `showDialog` buttons/menus beside the existing
workspace header, sidebar footer and open inspector strip in the main window. [Declarative dialogs](dialogs.md)
support text/switch/select fields and asynchronous searchable single/multi-select quick picks. Existing buttons,
their commands and native drag regions are not replaced. Host-rendered inspector views are described in
[the view contract](contracts.md#host-rendered-inspector-views-m6-experimental). Executable packages have a
separate [trusted runtime](runtime.md) and consent flow; install hooks remain unsupported.
The data vocabulary is described in [contracts.md](contracts.md); a schema-valid later capability is not
necessarily implemented by this adapter.

[Settings and actions](settings-actions.md) additionally documents namespaced persistent Settings pages,
status actions, searchable commands and conflict-resolved shortcuts; [core dialogs](core-dialogs.md) documents the
body/secondary-action band of every eligible main dialog. Its canonical `settings-laboratory` example is packaged with only
`extension.json` at the ZIP root. Core privacy, permission and recovery controls never accept third-party content.

[Auxiliary windows and native menus](windows.md) covers the actual `tray`, `launcher` and `agents-dock`
labels, native menu limitations and main-host form/quick-pick fallback. Its installable
`window-laboratory` fixture uses `extension.json` plus its declared SVG asset.

## Install the sample

Create a ZIP whose root contains `extension.json` and `assets/info.svg` from
`tests/fixtures/extensions/sample-project-helper/`. Do not wrap them in an extra directory.
For example, from that sample directory in PowerShell:

```powershell
Compress-Archive -Path extension.json,assets -DestinationPath sample.project-helper.zip
```

Keep the output outside the input directory when packaging repeatedly. The archive is a local unsigned
package, not a trusted publisher signature. In PandaCode, open **Settings → Extensions → Install local
package**, select the ZIP, inspect its identity and choose **Enable sample.project-helper**. Installation
alone leaves it disabled. Return to the workspace and activate **Project helper** with a pointer, Enter
or Space. The host displays `Extension installed successfully` once per activation.

For the submenu → dialog → select → confirmation flow, ZIP only `extension.json` from
`tests/fixtures/extensions/menu-laboratory/` at the archive root. Enable `sample.menu-laboratory` and
open **Menu laboratory → Reports → Configure report**. The same menu can target any of the three
action locations above by changing its `location`. The target must be an adopted host surface; an arbitrary
new view/window location is not enabled by a manifest declaration.

**Disable** removes that package's controls and preserves its stored package. Enable preferences survive
restart. **Uninstall** removes only the selected installation; extension data, projects, drafts and history
are retained. Failed records show a reason and **Retry**, which revalidates the record before enabling it.
Duplicate installation is rejected; replacing/updating packages is not implemented yet. A failed validation
does not create an active or partial package. No core database migration occurs.

## Recovery

For a complete data-panel example, ZIP only `extension.json` from
`tests/fixtures/extensions/data-panel/` at the archive root. Install and enable `sample.data-panel`,
then activate **Open data panel** or choose **Data panel** from the inspector's **+** menu. It includes
a declared command toolbar and list, tree, table, tabs and progress controls. Settings → Extensions →
Surface explorer exposes its tab visibility/order preferences. Disable or missing installation retains
saved tabs/selection, displays Changes, and restores the saved extension selection on re-enable unless
the user selected another tab. Closing/hiding a view disposes its presentation, not core work.

Launch PandaCode with `--safe-mode` to bypass extension storage enumeration and package loading before
activation. The built-in Extensions page also has **Disable extensions for this launch**, which removes
contributions immediately without changing enabled preferences or deleting package data. Restart without
the flag to retry the stored preferences. Corrupt records are diagnosed individually and cannot prevent
built-in startup. Checksums detect corruption, not publisher identity or malicious local administrators.

## Package limits

- ZIP: 2 MiB compressed, at most 64 entries (including directories), 256 KiB per file and 1 MiB expanded.
- Only `extension.json` and declared SVG assets are accepted as files. No executable files, runtime
  dependencies or lifecycle hooks are accepted or executed. All archive entry names are checked before
  installation, including undeclared entries; absolute/traversal/backslash names and links are rejected.
- Icons use a strict UTF-8 static SVG subset, at most 32 KiB: `svg`, `g`, `path`, `circle`, `rect`, `line`,
  `polyline`, `polygon`, `ellipse`, geometric attributes and `none`/`currentColor` fills/strokes. No CSS,
  scripts, events, URLs, images, entities, comments, XML declarations, nested SVG roots or arbitrary HTML.
  Unsupported icons are rejected, not repaired. Raster assets remain unsupported by this delivery.
- At most 64 stored packages. Records are schema-versioned under the application's own `extensions-v1`
  storage, separate from projects, tasks, credentials and terminal state. ZIP contents are validated in
  memory, never extracted to archive-controlled paths.

Browser preview uses a synthetic sample and localStorage, not the native ZIP installer. Native Rust tests
exercise the actual archive, storage and recovery policy. Installed-window UI and macOS/Linux native
qualification remain separate acceptance work; this experimental adapter is not a stability declaration.
