# Scoped live contributions

Slice R0205. A trusted package with `runtime.service` and the `ui.dynamic` grant can add, change and remove interface
contributions while it runs: status items, badges, buttons, menu entries, commands, views and slash commands, each at
any public location, optionally bound to one task or project. The items live in a run-time layer that the interface
merges over the manifest snapshot; when the service stops, the layer is gone and the manifest values return.

## What a package sees

```js
exports.service = async (panda, lifetime) => {
  const item = await panda.ui.register({
    kind: 'menu', id: 'sample.watch/alert', location: 'panda.status.items', command: 'sample.watch/open',
    presentation: 'status', text: '3 builds failed', tone: 'warning', tooltip: 'Three builds failed', progress: 10, args: { build: 41 },
  });
  await item.update({ text: '4 builds failed', badge: '4', tone: 'danger' });
  await panda.ui.update('sample.watch/status', { tone: 'danger' });          // an item of its own manifest
  await panda.ui.updateView('sample.watch/board', { controls });              // a view of its own manifest or a live one
  await item.dispose();
};
```

| Call | Does |
|---|---|
| `panda.ui.register(item)` | Adds one live item; answers a `RuntimeItem` (`id`, `update`, `dispose`). `kind` is `menu`, `command`, `view` or `slashCommand`. |
| `item.update(patch)` / `panda.ui.update(id, patch)` | Changes fields of a live item, or of an item of the package's own manifest (until the service stops). |
| `panda.ui.updateView(id, patch)` | Changes `title`, `text`, `controls`, `toolbar` of a view. |
| `item.dispose()` | Removes the item. A handle that is gone answers `NotFound`, however often it is used. |

- **Same validators as a manifest.** A registration goes through the checks a manifest entry does (`contribution`,
  `command`, `view`, `slashCommand`), with the same diagnostics, and the id must start with the package id. A `menu`
  item runs one of the package's own commands (a manifest command or one registered live); an unknown one answers
  `UnknownReference`. An id that a manifest entry or a live item already has answers `Conflict`.
- **Fields.** `update` may change `text`, `badge`, `icon`, `tone` (`neutral`, `info`, `success`, `warning`, `danger`),
  `tooltip` (up to 1,024 characters, line breaks kept), `progress` (integer 0 to 100), `enabled`, `visible`, `args`
  (opaque JSON up to 4 KiB, handed to the command as `context.args`), `items`, and for a view `title`, `text`,
  `controls`, `toolbar`. It may not change `id`, `kind`, `location` or `command`: dispose and register again.
- **Conditions.** `enabled` and `visible` are the same expressions a manifest has. `update` takes a boolean (which
  replaces the declared expression in the run-time layer) or `null` (which removes the override, so the declared one
  applies again). When the service stops, every override goes.
- **Which presentation shows what.** `status` shows text, tone, tooltip and progress; `badge` shows badge and tone;
  `button` and `icon` show text, icon, tooltip and enabled.
- **Table rows and tree nodes with a command.** A list item, tree node or table row of a host-rendered view may carry
  `command` and `args` (`{ "cells": ["tracks"], "command": "sample.sql/open-table", "args": { "table": "tracks" } }`);
  clicking it runs the command once with `context.args`.

## Scope and task marks

`scope: { taskId }` or `{ projectId }` exists only on a run-time registration (a manifest cannot name a task). It is
fixed at registration and checked when it is given: an unknown task or project answers `NotFound`. A scoped item is
shown only where its task or project is in view (the interface follows `task.shown`, see
[runtime-workspace-events.md](runtime-workspace-events.md)); another project's items never reach the window. When the
task or project is removed, its items go with it and their handles are stale.

`panda.sidebar.task.marks` is the location of the marks on a task row in the sidebar (`presentation: "badge"`). A mark
scoped to a task shows on that task's row, a mark scoped to a project on every row of that project, an unscoped one on
every row. A mark whose `visible` resolved to `false` is hidden. Every mark names its package in its tooltip and
accessible name.

## Limits (predictability, not trust)

- 128 live items per package; the 129th answers `LimitExceeded`. Disposing frees a slot.
- 20 applied updates per second per package. Past that, the latest value of each field waits and is applied when the
  window has room; no update is lost, and an item disposed in the meantime drops what waited for it.
- A service that stops (disable, uninstall, update, trust loss, safe mode, crash) loses every item at once, and the
  built-in or manifest values return.

## Refusals and why they stay

Each is kept for the reason given, never as a security measure on a trusted package (ADR-0005):

| Refusal | Reason |
|---|---|
| `PermissionDenied` without `ui.dynamic` | The grant is the permission, rechecked on every request. |
| `PermissionDenied` for another package's id | An id names one owner; a package changes only what it owns. |
| `Conflict` for a taken id | An id names one thing. |
| `UnknownReference` for an unknown command | A reference must resolve, as in a manifest. |
| `InvalidShape` / `LimitExceeded` for a field | A value must have the declared shape and size. |
| `InvalidShape` for `id`, `kind`, `location`, `command` in a patch | They are identity; dispose and register again. |
| `NotFound` for a disposed or unknown handle, task or project | There is nothing to change. |

## Files

- `src-tauri/src/extensions/runtime_dynamic_items.rs`: the layer, validation, limits, scope (pure); `serve_app` is the
  `ui` request of the service, `extensions_runtime_items` is what the interface reads.
- `src-tauri/src/extensions/runtime_service_lifetime.rs`: routes the `ui` request and clears the layer when the process
  ends.
- `src-tauri/src/extensions/node-host.cjs`: `panda.ui.register`, `update`, `updateView` and `RuntimeItem` in the service.
- `src/extensions/runtime-dynamic-items.ts`: the same rules for the browser preview and the deterministic spec, plus the
  merge the interface applies (`mergeLayer`, `taskMarks`); `src/extensions/manager.ts` applies it to every snapshot.
- `tests/fixtures/extensions/runtime-dynamic-items/`: the fixture service.
