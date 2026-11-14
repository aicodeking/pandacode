# Submenu, dialog and select (experimental API 1)

A declarative package: a **Reports** menu trigger in the workspace header opens a submenu whose
**Configure report…** item shows a host-rendered dialog with text, textarea, switch, single select
(one disabled option) and multi-select fields, and a confirmation step. No code runs.

```powershell
Compress-Archive -Path examples/extensions/submenu-dialog/package/* -DestinationPath $env:TEMP/sample.submenu-dialog.zip -Force
```

Install and enable it in Settings → Extensions, then open **Reports → Reports → Configure report…**.
Required fields block confirmation until filled; Escape cancels and shows `Report cancelled`.
The same menu works in any `action` location listed in
[capabilities](../../../docs/extensions/capabilities.md) by changing `location`. Field rules:
[dialogs](../../../docs/extensions/dialogs.md) and [primitives](../../../docs/extensions/primitives.md).
