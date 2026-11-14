# Layout and theme (experimental API 1)

A declarative package with a light/dark theme (`ink`: background, foreground, accent, font, row
padding and radius tokens) and a layout proposal that moves the sidebar footer's theme toggle
before Help. No code runs.

```powershell
Compress-Archive -Path examples/extensions/layout-theme/package/* -DestinationPath $env:TEMP/sample.layout-theme.zip -Force
```

Install and enable it. Enabling selects nothing: choose the theme and the **Theme toggle first**
layout explicitly in Settings → Extensions. Themes must keep 7:1 foreground and 3:1 accent contrast
(`InvalidAppearanceContrast` otherwise). Layouts only reorder compatible siblings and need
`ui.customize`. **Disable extension layouts** or safe mode restores the built-in order without
erasing your choices. See [contracts](../../../docs/extensions/contracts.md#selecting-and-reordering-layouts-m2-experimental).
