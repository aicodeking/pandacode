# Context panel (experimental API 1)

A declarative package: **Context panel** in the workspace header opens a host-rendered inspector
view with a list, a table, a progress bar and a toolbar. The toolbar's **Show project context**
command shows the captured project and task summaries. No package HTML or code runs.

```powershell
Compress-Archive -Path examples/extensions/context-panel/package/* -DestinationPath $env:TEMP/sample.context-panel.zip -Force
```

Install and enable it, then click **Context panel** (or pick it from the inspector's **+** menu).
`projects.summary` and `tasks.summary` are declared, but reading them still needs your explicit
grant in Settings → Extensions; without it the panel shows the denial instead of data. The view
captures its project when mounted: switching projects never retargets an open read.
See [contracts](../../../docs/extensions/contracts.md#host-rendered-inspector-views-m6-experimental).
