# Task control: stop, set mode, configure and compact (`tasks.control`)

A trusted background service controls a task with `panda.tasks.stop`, `setMode`, `configure` and `compact`. Each call is a thin
adapter over the operation the interface already runs, with the same arguments and the same refusals, and it is labelled with
the package's name. Councils, workers and usage-limit pauses are a later slice (R0404B) and have no call here.

```ts
panda.tasks.stop(taskId: string): Promise<null>;
panda.tasks.setMode(taskId: string, mode: 'ask' | 'auto' | 'review' | 'plan' | 'full'): Promise<null>;
panda.tasks.configure(taskId: string, change: { harness?: string; model?: string; effort?: string | null; team?: string | null;
  connection?: string | null; bot?: string | null; target?: string; stage?: 'active' | 'completed' }): Promise<null>;
panda.tasks.compact(taskId: string): Promise<null>;
```

## Permission

`tasks.control`, **per project** (the task's project). It is granted with the trust decision, listed at install, rechecked on
every request (twice: at admission and again just before anything changes, so a revoke or a narrowing in between changes
nothing), revocable and narrowable by the user. A package that holds it is never asked per action (ADR-0005). No credential is
involved (ADR-0006): `connection` names an id from the connections list, never a value.

## What each call runs

| Call | Interface operation | Notes |
|---|---|---|
| `stop` | `stop_session` (`architect_control` with `stop` for a team, as the Stop button does) | An idle local task has nothing to stop: the call changes and records nothing. A stop by a package reaches `task.stopped` as `by: {package}` |
| `setMode` | `update_session` with `mode` and `warm: true` | Refused while an agent runs (Stop first) |
| `configure.harness` + `model` | `configure_session` | The picker always names the model with the harness: a harness without a model is `InvalidShape` at `model`. A model alone keeps the task's harness |
| `configure.effort` | `set_reasoning_effort` (`null` clears) | Checked against the model's offered efforts when the catalog lists them |
| `configure.team` | `architect_configure` with the profile's own config and architect (`null` removes the team) | An unknown profile is `NotFound` |
| `configure.connection` | `connection_assign` (`null` clears) | The task starts a fresh harness session and carries the conversation forward, as the menu does |
| `configure.bot` | `bot_assign_task` (`null` unlinks) | The window applies the bot's harness and model afterwards, as it does for the menu |
| `configure.target` | the Run on choice of a new conversation | Held by the main window, which answers whether it could apply it. `local` or a machine that is already paired; pairing and remote access are not package operations |
| `configure.stage` | `set_task_stage` (reopening first clears the archive flag, as the stage menu does) | Refused while an agent runs |
| `compact` | a `/compact` message sent as the composer sends it | See below |

The commands of each action are plain data (`plan` in `runtime_tasks_control.rs` and `runtime-tasks-control.ts`, one twin each),
so a recording of the interface's own calls compares equal to what an action runs:
`tests/fixtures/extensions/runtime-tasks-control/parity.json` is read by the browser spec and by
`runtime_tasks_control::tests`. A `configure` with several fields runs them in the interface's order (harness and model, effort,
team, connection, bot, target, stage); a failure names the commands that already ran in `ids`.

## Compaction

Compaction uses what the harness has: its own request (Codex `thread/compact/start`) or its `/compact` command (Claude and the
command catalog of a package harness). The host resolves `/compact` against the task's harness first; a harness whose command
catalog has no `/compact`, or one that is not installed, answers `UnsupportedCapability` (path `compact`) and nothing is sent.
A running task answers `Conflict`, as does a Codex task with no conversation yet ("Start a conversation before compacting").
The `task.compacted` workspace event is the host's record of the finished "Compact context" step
(`runtime_workspace_events::observe_tool`), so it is emitted when the compaction completes, not when it was requested.

## Hooks and the mode

A hook cannot silently change a task's mode (PLAN.md, Decisions). A `setMode` made from inside a hook handler is refused:
`PermissionDenied`, `path: "setMode"`, `ids: ["hook"]` (the service host marks the request `source: "hook"`; a hook that holds the
grant may still stop or compact). A service that sets the mode itself is recorded with its name.

## Attribution

Every successful control is kept in the control ledger (`ControlLog`: task, action, the commands that ran, package id, package
name, time; bounded to 1,000, a deleted task loses its rows). The main window reads the latest control of the open task through
`extensions_runtime_task_controls` and the event `extensions-runtime-task-controls`, and draws it in the thread header
("Mode set by Task controller"). The preview twin is `TaskController` in `runtime-tasks-control.ts`.

## Refusals

| Code | When |
|---|---|
| `PermissionDenied` (path `tasks.control`) | no grant, a revoked grant, a disabled package, a task of a project outside the narrowed scope; also an unknown task id while the package holds the permission for no project at all (an id is never confirmed to a package with no business with tasks) |
| `PermissionDenied` (path `setMode`, ids `["hook"]`) | a mode change from a hook |
| `NotFound` | unknown task, harness, model, team profile, connection, bot or machine (path names the field) |
| `HostUnavailable` (ids: `signedOut` or `unavailable`) | the target harness is signed out or not installed |
| `Conflict` | a running agent where the interface says "Stop the agent first"; a conversation not started yet (compaction); a Run on choice for a conversation that already started |
| `UnsupportedCapability` | compaction the harness lacks; a mode the harness does not offer (path `mode`) |
| `InvalidShape` | unknown field or action (council, worker and limit included), empty change, a value out of its set, a harness without a model |

The refusals that remain are for predictability and fault isolation; none is a security restriction on a package that holds the
permission.

## Refusal-test reconciliation (Q rows owned here)

R0404 delivers the permissioned native operations. The listed rows assert that the declarative, host-choice paths (a contributed
control with an action `stop`, `mode-set`, `model-set`, `effort-set`, `team-set`, `stop-worker`, ...) cannot carry task-control
authority. Those paths are routed through the host's per-control decision and the contributed-action ids by R0505 and R0507, and
council, worker and limit actions by R0404B; this slice changes none of those files and so no assertion in them. What is
changed and what stays:

| Rows | Delivered by R0404 (permissioned assertion) | Retained refusal and its non-security reason |
|---|---|---|
| Q001, Q046 (thread action kinds `stop_session` and the like) | a package holding `tasks.control` stops through `panda.tasks.stop` | the declared thread-action kinds still do not validate: they are a manifest surface with no service, and the call needs a running service (R0505/R0507 own the contribution path) |
| Q002, Q068, Q094 (composer `mode-set`, `model-set`, `effort-set`, `team-set`, `stop`) | `setMode`, `configure` (harness, model, effort, team) reach the same operations as the pickers | contributed composer controls stay refused here because the protected-location layout and the host choice are R0402/R0505 |
| Q008, Q074, Q101 (task menus: team, stage, deploy) | `configure.team` and `configure.stage` | menu entries stay refused: the entry mechanism is R0405 |
| Q010, Q076, Q103 (bot conversation controls) | `configure.bot`; stop of a bot thread is a task stop | `bot-stop` of a shared channel is not a task operation (R0406) |
| Q013, Q014, Q079, Q080, Q105, Q106 (action dock and roster `stop`, `stop-worker`, `approve`) | task `stop` | worker, council and limit controls are R0404B; approvals are R0505/R0507; the roster controls are R0407 |

## Limits

- Tests are written for the browser preview column and as native unit tests; the installed service against a real harness is
  not claimed (separate column, needs a harness run that requires explicit authorization).
- `configure.target` needs the main window and is `UnsupportedCapability` in headless mode.
- The preview has no service: `extensions_runtime_task_controls` answers an empty ledger and the spec fills it through
  `window.__runtimeTaskControls`.
