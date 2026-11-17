# A live, task-scoped composer band (`ui.presentation`)

Runtime phase R10, slice R1001. A trusted package puts one segment in a row above the composer. The segment can be a status
item or a small rich panel, it can change while a task runs, and it can belong to one task. The permission is
`ui.presentation` (global): granted with the trust decision, rechecked natively on every request, revocable by the user. A
package that holds it is never asked again per action (ADR-0005).

## What a package declares

A status segment is a `contributes.menus` entry at the new location `panda.composer.band` with `presentation: "status"`:

```json
{ "id": "sample.usage/band", "location": "panda.composer.band", "command": "sample.usage/open", "presentation": "status",
  "icon": "chart", "text": "Usage 42%", "tone": "warning", "tooltip": "Tokens used by this task", "progress": 42,
  "items": [{ "id": "sample.usage/band-pause", "kind": "command", "title": "Pause", "command": "sample.usage/pause" }] }
```

| Field | Meaning |
|---|---|
| `text` | the label (at most 120 characters are drawn; falls back to `badge`, then to the package name) |
| `icon`, `tone` | a host icon id; `neutral`, `info`, `success`, `warning` or `danger` |
| `progress` | an integer 0 to 100, drawn as a thin bar |
| `tooltip` | hover text; the package name always leads it |
| `command` | what a click runs (once, with the item's `args` as `context.args`) |
| `items` | up to three command buttons; a fourth is `LimitExceeded`, anything but a command item is `InvalidShape` |
| `visible`, `enabled` | `false` hides the segment or disables its click |

A rich segment is a view whose `location` is `panda.composer.band`. Its `rich.minSize.height` is 24 to 96 px (the context
exception C04: the broad `rich` bounds are checked first, then the band narrows them), `rich.placement` must be absent, and
the panel is mounted at the segment's full width by the same trusted mount as the inspector's (`ui.richViews` is needed too).
Outside the band a view still needs 160 px or more. A view's `location` is `panda.inspector.views` (the default) or the band.

A service changes a segment with `panda.ui.update(id, patch)` (a manifest item) or `RuntimeItem.update` (a registered one),
and registers a task's own segment with `panda.ui.register({ kind: 'menu', location: 'panda.composer.band', scope: { taskId } })`
(`ui.dynamic`). A scoped segment shows only while that task is in view and goes with the task. A manifest segment shows for every
task. The run-time layer of `runtime-dynamic-items.md` already merges these over the manifest, so the band reads the same
snapshot as every other surface and responds to each service event at once.

## What the user sees

- One segment per package: its band view when it declares one, else its first valid status item.
- Three segments are drawn. The rest fold into a trailing **⋯** menu, which is also where the user manages the band. The
  menu is the host's choice menu, so it opens from the keyboard (Enter, Space), moves with the arrow keys and closes with Esc.
- Each segment names its package (the tooltip and the group label), as everything an extension shows does.
- **Hide, order, restore.** The menu lists `Hide <package>`, `Move <package> earlier`/`later` and, for what is hidden,
  `Show <package>` and `Restore all hidden segments`. They are stored in the layout overlay under the location, globally and
  per project, like every other contribution point, so they persist and Settings shows the same controls.
- The band is additive. It never replaces or moves a composer control. Disabling the package, revoking `ui.presentation`,
  stopping the service (the run-time layer is cleared and the manifest values return) or safe mode removes the band; the
  built-in composer, the draft and a running task are untouched. With no extension the band does not exist.

A click on a segment or a button runs `invokeExtensionCommand` with the captured project and task (`sessionId`) and the item's
`args`. It never carries the draft, and the band has no way to send, stop, approve or change the model: those stay host-owned.

## Where each part runs

- **Native** (`src-tauri/src/extensions/runtime_composer_band.rs`): `check_item` and `check_view` (the C04 validators),
  `gate` (the permission recheck of a registration or update that targets the band: `PermissionDenied` without
  `ui.presentation` now), `strip_ungranted` (removes the band items of an owner that lost the grant from the layer the
  interface reads), and the selection rules (`segments`, `arrange`, `step_placement`).
- **Interface** (`src/extensions/runtime-composer-band.ts`): the same rules as a pure model, and `mountComposerBand`, which
  draws the row right above `#composer-area` (outside it, because the composer area is redrawn by `innerHTML`). It reuses the
  rich panel mount (`mountRichPanel`), the layout store (`layout.setVisible`, `layout.move`, `orderedControls`) and
  `invokeExtensionCommand`.
- **Styling** is in `src/extensions/extensions.css`, which `main.ts` imports at start, so the first draw is styled and nothing
  arrives with a lazily imported stylesheet. Colors are `--accent`/`--ds-*` tokens; the progress fill moves with `scale`, never
  with width; nothing animates layout.

## Failure and limits

Limits are for reliability, not safety: three drawn segments, three buttons, 120 drawn characters, 24 to 96 px for a panel. A
panel that fails shows the host note and a reload control of the rich mount and leaves the other segments alone. A refused
registration answers a frozen code (`PermissionDenied`, `InvalidShape`, `LimitExceeded`) to the service; nothing is
confirmed with the user.

## Verification

`tests/extensions-runtime-composer-band.spec.ts` (preview and model column) and `runtime_composer_band::tests` (native unit
column). Installed-app qualification of the native panel inside the band is reported separately in the receipt.
