# Recipes and wake-ups (`workspace.recipes`, `workspace.wakeups`)

Runtime phase R4, slice R0406B. A trusted background service manages the app's workflow recipes and its wake-ups (task
schedules):

```js
const { id } = await panda.workspace.recipes.save({ scope: 'project', projectId, name: 'review-diff', steps: [{ kind: 'prompt', text: 'Review the diff.' }] });
const recipes = await panda.workspace.recipes.list({ projectId });          // project recipes, plus the global ones
await panda.workspace.recipes.run(id, { taskId });                           // queues the recipe's messages in that task
await panda.workspace.recipes.remove(id);                                    // the host asks the user first, by default

const wake = await panda.workspace.wakeups.create({ sessionId: taskId, title: 'Morning', prompt: 'Continue.', kind: 'daily', timeOfDay: '09:30' });
await panda.workspace.wakeups.update(wake.id, { sessionId: taskId, prompt: 'Continue.', kind: 'interval', intervalMinutes: 90 });
const mine = await panda.workspace.wakeups.list({ taskId });
await panda.workspace.wakeups.remove(wake.id);
```

The permission is `workspace.manage` (the same one every `workspace.*` family except settings uses), project scoped, listed
at install, granted with the trust decision, checked against the grants file on every call and once more right before each
write, and revocable and narrowable by the user. A package that holds it is never asked per action (ADR-0005). Pairing a
machine, signing in to the cloud and approving remote access stay with the user: there is no call for them, and there is no
credentials API (ADR-0006).

## Every frozen method and its native operation

The shorthand of the plan (`recipes: { list(), save(recipe), remove(recipeId), run(recipeId, options) }`,
`wakeups: { list(), create(input), update(wakeupId, input), remove(wakeupId) }`) fixed names and argument order; the inputs
below are fixed here, as the native operation takes them, in camelCase.

| Call | Input | Native operation (what the interface calls) | Answer |
|---|---|---|---|
| `recipes.list(options?)` | `{ projectId? }` | `recipes_list` (`recipes::list_dir` of the project folder `.pandacode/recipes` and of the global folder) | `WorkspaceRecipe[]` |
| `recipes.save(recipe)` | `{ scope: 'project' \| 'global', projectId?, name, description?, steps }` | `recipes_save` (`recipes::save`, which validates the name, the 50-step bound, each step's kind and text) | `{ id }` |
| `recipes.remove(recipeId)` | a recipe id | `recipes_delete` (`recipes::delete`) | `null` |
| `recipes.run(recipeId, options)` | `{ taskId }` | `recipes_dry_run` against the task's harness and slash commands (`list_slash_commands`), then `queue_add` for each message, as the Run button does | `{ recipeId, taskId, queued, entries, steps }` |
| `wakeups.list(options?)` | `{ taskId? }` | `schedules_list` | `WorkspaceWakeup[]` |
| `wakeups.create(input)` | `ScheduleInput`: `sessionId`, `title?`, `prompt`, `kind`, `intervalMinutes?`, `timeOfDay?`, `days?`, `runAt?`, `watchSessionId?`, `onlyOnSuccess?`, `maxRuns?`, `workflowId?`, `chainFromId?` | `schedule_create` (`schedules::create`) | the wake-up |
| `wakeups.update(wakeupId, input)` | the same `ScheduleInput` | `schedule_update` (`schedules::update`) | the wake-up |
| `wakeups.remove(wakeupId)` | a wake-up id | `schedule_delete` (`schedules::delete`) | `null` |

A recipe id is `global:<name>` or `project:<projectId>:<name>`. A wake-up id is the schedule's id; its `sessionId` is the
task it wakes. There is no `wakeups.run`: it is not one of the eight frozen methods, a wake-up fires on its own cadence, and
a one-off message to a task is `tasks.message` (R0402). `recipes.run` is the "run" of this slice.

## Scoping and the confirmation of removals

- **Project scope.** A project recipe, and a wake-up (through its task's project), is checked against that project. A
  wake-up that watches another task, or is moved to another task, is checked against both projects. A global recipe, and
  `recipes.list` without a `projectId`, need a grant that is not narrowed to chosen projects. A narrowed package sees only
  the wake-ups of its projects, and a project it is narrowed away from answers `PermissionDenied` before anything about it
  (an unknown task included) is revealed.
- **Irreversible removals.** `recipes.remove` and `wakeups.remove` keep the host's confirmation **by default**, naming the
  package and what will be destroyed. The reason is irreversibility, not distrust. The user turns it off per package
  (`preferences.confirmDeletions`, `FamilyConsents`), and a refusal answers `Cancelled` and changes nothing. The
  authority is read again when the answer arrives, because it may have been revoked while the dialog was open. One
  dialog is open per package: a second removal while one is open answers `Conflict`.
- **Recipe run.** The task's harness decides the dry run. A step the harness cannot run (a blocked step) is
  `UnsupportedCapability` with the step numbers in `ids` (`step-2`), and nothing is queued in its place: a step never
  silently takes a weaker path. Otherwise each message is queued as an ordinary one, in order, and the grant is read again
  before each. A revoke or a narrowing in the middle leaves what was already queued, queues no more and answers
  `PermissionDenied` with the queued entry ids in `ids`. Each queue row carries the package's name, and the thread shows
  one labelled line (`Recipe "name" run by <package>: n queued`).

## Failure behaviour

| Situation | Answer |
|---|---|
| No grant, revoked, disabled package, safe mode, project outside the narrowed scope | `PermissionDenied`, `path: "workspace.manage"` |
| Unknown project, task, recipe or wake-up (including one removed meanwhile) | `NotFound`, `path` names the field (`taskId`, `recipeId`, `wakeupId`, `input.sessionId`) |
| A field the call does not take, a malformed id, a step or recipe the interface's own validation refuses | `InvalidShape` |
| Too many steps or recipes, text over its bound, `maxRuns` outside 1 to 1000 | `LimitExceeded` |
| A blocked recipe step; an unknown harness | `UnsupportedCapability` |
| The host confirmation was refused | `Cancelled` |
| A second dialog while one is open | `Conflict` |

The interface shows the native message; a service gets the code (`code_of_text`). The bounds are for predictability and
fault isolation, never for trust.

## Attribution

Every recipe a package saved and every wake-up it created carries its name (`by` in the list, and the file-backed ledger
`workspace-schedule-origins.json` next to the grants, which the window reads with `extensions_workspace_origins`). The
name survives the package being removed. A removal forgets the entry. Saving an existing recipe is an update and takes the
entry over.

## Disable, revoke, fault and zero-extension behaviour

- Disabling or revoking changes nothing that exists: recipes, wake-ups and queued messages stay exactly as they were; only
  the package's authority goes, and the next call answers `PermissionDenied`.
- A fault in the service ends the service and nothing else: a call that was answered is not undone, one that was not
  answered did not land (a wake-up is written in one transaction under the store's lock).
- With no extension installed, all disabled or safe mode, nothing here is registered, no ledger is written and the recipes
  dialog and the schedules behave exactly as the original at 0.3.128.

## Where each part runs

- **Native** (`src-tauri/src/extensions/runtime_workspace_schedules.rs`): ids, shapes, the grant check (twice), the
  confirmation through `FamilyConsents` and the dialog slot, the dry run, the queue and the attribution ledger. Requests
  `workspaceRecipes` and `workspaceWakeups` (`op: list | save | remove | run`, `list | create | update | remove`) of
  `node-host.cjs`, served in `runtime_service_lifetime.rs`.
- **Window**: nothing new to draw. It already shows the queue row, the thread line and the schedules; the schedules
  changed event (`schedules-changed`) and the queue event (`queue-changed`) refresh them.
- Preview twin: `previewWorkspaceSchedules` in `src/extensions/runtime-workspace-schedules.ts` (same ids, shapes and
  refusal envelope, labelled stand-in). It proves protocol and rules; it never qualifies a service process, the recipe
  files, the schedules database or the real queue.

## Refusal-test reconciliation

Owner rows: Q004, Q070, Q090, Q091, Q097, Q115. They are mixed rows, split by operation among their listed owners (R0403,
R0401, R0402, R0505, R1001); this slice owns the recipe and wake-up operations.

What this slice delivers is the **service call**: a service that holds `workspace.manage` now saves, edits, removes and
runs recipes and creates, edits and removes wake-ups. The permissioned assertions that change are the ones that said "a
package cannot do this" for those operations; they are carried by `tests/extensions-runtime-workspace-schedules.spec.ts`
(granted round trips and refusals) and by `runtime_workspace_schedules::tests`. No assertion of an old test file was
edited: the old rows assert that **contribution actions** are refused, a contract this slice leaves as it was (a recipe
or wake-up change is a service call with a grant, not a declarative control), so every old refusal still holds.

| Rows | Surface | Changed by this slice | Retained refusal and its non-security reason |
|---|---|---|---|
| Q004, Q070 | attach menu, recipes dialog, wake-up controls (`composer-attach`) | recipe save, remove and run, and wake-up create, update and remove are now a granted service call | the nine attach controls and the protected controls (`recipe-delete`, `recipe-save`, `recipe-cancel`, `wake-create`, `wake-remove`, ...) stay refused as contribution actions: they are the user's own gestures in the composer, a fresh choice (predictability), and the protected location keeps the dialogs stable (stability). Attaching files and the draft stay with R0403 |
| Q097 | composer attach coverage | the same operations, with package attribution | `attach-file`, `recipe-run` and `wake-run` stay choice controls answering a fresh user choice when pressed from a menu: a menu item is not a service call. `recipe-run` through the service is `recipes.run` |
| Q090, Q091 | GitHub view, board | none for recipes and wake-ups beyond the board's recipe use being reachable by `recipes.run` | `start` and `solve` stay `PermissionDenied` before the consent as contribution actions; starting tasks is `tasks.start` (R0401) and board control is R0404 |
| Q115 | board, GitHub view, BTW coverage | the recipe selected on the board can be run by a service (`recipes.run`) | `start`, `solve`, `insert`, `send` and `approval-allow` stay refused as contribution actions: they are task and hook operations (R0401, R0402, R0505) |

## Evidence columns

Preview/model: `tests/extensions-runtime-workspace-schedules.spec.ts` (ports 16331 Chromium, 16332 WebKit). Native unit
tests: `runtime_workspace_schedules::tests`. An installed service driving `sample.runtime-workspace-schedules` against the
real recipe files, schedules database, queue and grants file: the final test phase and R1212 qualification.
