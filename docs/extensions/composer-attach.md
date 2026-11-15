# Composer Attach menu, Workflow recipes and wake-ups v1 (experimental)

## Decision

Before v1 the composer's Attach menu (`src/main.ts`, opened by the Attach button and filled by `src/attachments.ts`),
a Files row's Attach button, the Workflow recipes dialog (`src/recipes.ts`) and the composer's wake-ups
(`src/schedules-thread.ts`: the strip, "Wake this thread later" and a wake-up's ⋯ menu) had no extension hook: no
public registry, order, visibility, contributed actions or captured action. Only the recipes dialog carried the
generic dialog accessory band (`panda.dialog.recipes.actions`, [core dialogs](core-dialogs.md)), which stays as it is.
v1 adds, owned by `src/extensions/composer-attach-core.ts` (registry `ATTACH_REGISTRY`, admission) and
`src/extensions/composer-attach-host.ts` (presentation, slots, menu surfaces, captured actions):

- `panda.composer.attach.actions`: the Attach menu. Its own entries (Attach files, Attach a folder, Project files,
  Sketch a mockup, Workflow recipes, Schedule a wake-up) hide and reorder in the menu; Attach files never hides and
  keeps its place. Contributed rows follow the menu's entries, captured with `selection.kind = "draft"`,
  `ids = [task]` (never the draft text or attachment paths). After the task or the draft changed, a choice in that menu only closes it;
- `panda.composer.recipes.controls`: the recipes dialog's Edit and Run, ordered after Delete (which stays first and
  protected), and New recipe, which hides in place under the list. Run never hides;
- `panda.composer.recipes.actions`: a slot leading the selected recipe's actions, captured with
  `selection.kind = "recipe"`, `ids = ["<scope>:<name>"]`;
- `panda.composer.wake.controls`: the time choices of "Wake this thread later" (In 15 min, In 1 h, Tonight,
  Tomorrow; In 1 h, the default, never hides) and More options, which hides in place;
- `panda.composer.wake.actions`: a slot in that popover's footer, captured with `selection.kind = "task"`,
  `ids = [task]` (the thread the quick add opened for, also from the sidebar's task menu);
- `panda.composer.wake.context`: a wake-up's ⋯ menu (`panda.menus.wake`). Its entries (the snoozes, Pause or resume,
  Edit) hide and reorder; Remove never hides and keeps its place. Contributed rows follow, captured with
  `selection.kind = "schedule"`, `ids = [schedule]`; after the wake-up changed or another task opened, a choice in that menu only closes it;
- `panda.composer.attach.protected`, inspect-only: draft attachments, file drops and drags; deleting a recipe; saving
  or cancelling a recipe edit; recipe steps and the dry run; scheduling a wake-up; removing a wake-up; snoozing,
  pausing or resuming without a choice;
- the `composerAttachPresentation` / `composerAttachAction` contracts for captured actions.

The Attach and ⋯ menus become extension surfaces (`showChoices` with `extensionSurface`) only when a package
contributes to them or the user arranged them; otherwise, and in safe mode, the built-in menu opens exactly as before.
The recipes dialog and the quick add draw their own markup on each draw, so the user's order and visibility are part
of that markup; hidden controls keep their node, out of view and inert. OS file drops (Tauri's `onDragDropEvent`, the
macOS/preview DOM drop) and `src/pointer-drag.ts` replay are unchanged: no package sees or changes what they attach.

Rejected alternatives: a package-rendered Attach menu or quick add (would copy the pickers, the image and document
limits and the scheduler's form and move draft and schedule changes out of the host); hiding Attach files, Remove,
Run, Delete, Save, Cancel or Schedule (the surfaces' purpose or the user's way out of an edit); per-recipe or
per-wake-up layout items (dynamic per project and per thread); letting packages attach paths, delete recipes or create,
remove or snooze wake-ups (protected); a new composer recipe (the T33 `toolbar-first` provider is reused as the owner
of captured actions).

## Captured actions

The owner is the selected, unfaulted `panda.composer` provider (`toolbar-first`). A `composerAttachAction` carries the
opaque window, mount, project, task and revision of the `composerAttachPresentation` it was built from, plus a control
handle and its resource: the task's draft for the Attach button, the file for a Files row's Attach, the recipe (its
steps digest; an edit makes it a new resource) for recipe controls, and the wake-up (its edits, pause and resume make
it a new resource) for a strip row's controls. The presentation carries whether the draft holds anything and how many
attachments it has, never text, paths or steps. Editing the draft, adding or removing an attachment, a redraw of the
recipes dialog, a changed wake-up, switching task or any redraw changes the revision: an older request is
`StaleContext`.

| Control | Effect |
| --- | --- |
| `attach-open` | Opens the original Attach menu; only the user's own choice there picks files. |
| `attach-file` | Shows a fresh host choice ("Extension requested an attach action"); Continue runs the Files row's original Attach for the same task and draft. Escape declines. |
| `recipe-pick`, `recipe-new`, `recipe-edit` | Run the original row, New recipe or Edit handler in the open dialog; the user saves or cancels. |
| `recipe-run` | The same fresh choice, then the original Run, which queues the captured recipe's steps once for the dialog's task. |
| `wake-expand`, `wake-add`, `wake-more` | Run the strip's original disclosure, open the original quick add or the wake-up's ⋯ menu, where only the user's own choice schedules or changes anything. |
| `wake-run`, `wake-enable` | The same fresh choice, then the original Run now or the wake-up's own switch for the same wake-up. |

`attach-paths`, `attach-remove`, `recipe-delete`, `recipe-save`, `recipe-cancel`, `wake-create`, `wake-remove`,
`wake-snooze` and `wake-set` are refused with `PermissionDenied` before any other check. Other reasons: `Revoked`
(safe mode, fault, disable, another owner's identity), `WrongOwner`, `InvalidArguments`, `UnsupportedCapability`
(disabled or hidden control, other contract version), `Busy` (an open picker, menu, another dialog or host choice; the
recipes dialog itself is this adapter's surface), `AlreadyApplied`.

## Recovery

Fault, disable, another selected provider and safe mode restore the built-in Attach menu, recipes dialog and quick
add: draft text and attachments, recipe steps, wake-ups and focus stay; no attach, recipe run or schedule change is
repeated. Safe mode restores built-in order and visibility without deleting the stored preferences. Installed WebView
qualification is not claimed; evidence is the browser preview (`tests/extensions-attach-wake-coverage.spec.ts`,
Chromium and WebKit), the Node contract tests (`tests/extensions-attach-wake.test.mjs`) and native contract/package
tests.
