# Local declarative extensions (experimental)

The first adapter adds host-rendered `showMessage` icon buttons beside the existing workspace header
controls in the main window. Existing buttons, their commands and native drag regions are not replaced.
Sidebar buttons, custom views, executable JavaScript and install hooks are not supported by this slice.
The data vocabulary is described in [contracts.md](contracts.md); a schema-valid later capability is not
necessarily implemented by this adapter.

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

**Disable** removes that package's controls and preserves its stored package. Enable preferences survive
restart. Duplicate installation is rejected; replacing/updating/uninstalling packages is not implemented
yet. A failed validation does not create an active or partial package. No core database migration occurs.

## Recovery

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
