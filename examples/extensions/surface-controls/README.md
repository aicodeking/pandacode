# Workspace surface controls (experimental API 1)

One declarative package touching the control families delivered for the workspace, dock, sidebar,
dialogs and auxiliary windows:

- recipes for Board (`review-first`), the action dock (`actions-first`) and the sidebar (`filter-first`);
- actions in Simulator, the Board header and card context, the action dock, the sidebar Bots
  panel head and bot rows, the Rename task dialog band, the tray popover and the tray OS menu;
- layouts for the Board header and the Bots panel groups;
- a dialog extra in the Rename task dialog.

```powershell
Compress-Archive -Path examples/extensions/surface-controls/package/* -DestinationPath $env:TEMP/sample.surface-controls.zip -Force
```

Install and enable it, then open each surface. Recipes and layouts are opt-in in Settings →
Extensions. In the tray OS menu the icon is omitted and **Choose format…** opens its select in the
main window (see the host fallbacks in [capabilities](../../../docs/extensions/capabilities.md)).
Business actions (moving tasks, workers, Stop, bot deletion, confirmations) stay with PandaCode.
Per-family rules: [board](../../../docs/extensions/board.md), [action dock](../../../docs/extensions/action-dock.md),
[sidebar](../../../docs/extensions/sidebar.md#bots-panel), [simulator](../../../docs/extensions/simulator.md),
[core dialogs](../../../docs/extensions/core-dialogs.md) and [windows](../../../docs/extensions/windows.md).
