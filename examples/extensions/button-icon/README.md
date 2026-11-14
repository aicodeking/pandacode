# Button with icon (experimental API 1)

A declarative package: one `showMessage` command shown as a **Hello** button in the workspace
header and as an icon button in the sidebar footer, with a static SVG icon. No code runs.

Package and install (see the [author guide](../../../docs/extensions/README.md#quick-start)):

```powershell
Compress-Archive -Path examples/extensions/button-icon/package/* -DestinationPath $env:TEMP/sample.button-icon.zip -Force
```

Install the ZIP in **Settings → Extensions → Install local package**, then **Enable
sample.button-icon**. Click **Hello** (pointer, Enter or Space): the host shows
`Hello from an installed extension`. Disable removes both buttons; the package stays installed.

The icon must stay inside the static SVG subset described in [install](../../../docs/extensions/install.md#package-limits);
an undeclared file in the ZIP or a missing icon makes installation fail with no partial package.
