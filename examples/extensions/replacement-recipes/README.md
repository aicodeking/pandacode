# Replacement recipes (experimental API 1)

A declarative package offering two closed, host-rendered presentation recipes: **Project cards**
for `panda.projects` and **Results first** for `panda.search`. A recipe changes presentation only;
PandaCode keeps the projects, the search query/scheduler and the original open handlers. No code runs.

```powershell
Compress-Archive -Path examples/extensions/replacement-recipes/package/* -DestinationPath $env:TEMP/sample.replacement-recipes.zip -Force
```

Install and enable it, then select each provider in Settings → Extensions (component selection).
Installing or enabling never selects a recipe; competing packages never win by activation order.
Choose **Built-in**, disable the package or use safe mode to return to the original surface
without losing live work. See [replacement](../../../docs/extensions/replacement.md) and
[compatibility](../../../docs/extensions/compatibility.md).
