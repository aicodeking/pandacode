# Attributed task start (`tasks.start`)

Runtime phase R4, slice R0401. A trusted background service starts a task the way the user's own New task does, and the
task carries the package's name in the sidebar, the thread and the history. The permission is `tasks.start`
(project scoped, granted with the trust decision, rechecked natively on every request, revocable and narrowable). A
package that holds it is never asked again per action (ADR-0005); the user's host confirmations are not part of it.

```js
const task = await panda.tasks.start({ projectId, prompt, title: 'Fix T-12', worktree: 'new' });
// -> { id, projectId, worktree: 'pandacode/fix-t-12-ab12cd' | null }
```

| Option | Meaning |
|---|---|
| `projectId`, `prompt` | Required. The prompt is sent as the first message (at most 200,000 bytes). |
| `harness`, `model`, `effort`, `mode` | Optional; default to what the user would get for a new task in that project. |
| `title` | Optional, at most 200 characters; names the task. |
| `worktree` | `'current'` (default), `'new'` (the host makes a branch `pandacode/<title or prompt>-<task id>` and its checkout, as the user's own action does) or the name of an existing branch. |
| `target` | A machine that is already paired and accepts remote control. The task runs there; its mirror row is the local task. |
| `attachments` | Up to 16 attachment ids, sent with the prompt as the composer sends them. |

Unknown options answer `InvalidShape`. There is no option, call or permission here that pairs a machine, links one or
grants remote access: those stay with the user (PLAN-contracts, answer D3), and a `target` that is not already paired is
`NotFound`.

## Where each part runs

- **Native** (`src-tauri/src/extensions/runtime_tasks_start.rs`): admission, the frozen refusals, the permission check
  (twice, see below), the task creation, the worktree, the prompt, the attribution ledger and the `task.created` event.
  Request `tasksStart` of `node-host.cjs`, served in `runtime_service_lifetime.rs`.
- **Main window** (`src/extensions/runtime-tasks-start.ts`, mounted from `src/main.ts`): only the user's defaults, which
  live in the window (the default harness, the remembered model, the initial mode, the catalog and each harness's
  readiness). The native side emits `extensions-runtime-task-defaults`, the window answers with
  `extensions_runtime_task_defaults_answer`, and a start waits at most 15 s for it (`Timeout`).
- **Preview twin**: the same file holds `admit`, `resolveDefaults`, `TaskStarter` and the ledger without I/O; the browser
  specs and `runtime-preview.ts` (`panda.tasks.start`) run it.

## Order of the refusals (frozen)

1. Shape of `projectId`: `InvalidShape`.
2. The grant for that project: no grant, a revoked one, a disabled package, safe mode, or a project outside the narrowed
   scope is `PermissionDenied` with `path: "tasks.start"`. Nothing else about the request is revealed before it.
3. The rest of the shape: `InvalidShape`, or `LimitExceeded` for a size bound (prompt, title, attachments).
4. The project and the target: `NotFound` for an unknown project or a machine that is not paired.
5. The window's answer: an unknown harness is `NotFound`; one that is not installed is `HostUnavailable` with
   `ids: ["unavailable"]`, one that is signed out `ids: ["signedOut"]`; a mode or model the harness does not declare is
   `InvalidShape` or `NotFound`.
6. The grant again, just before anything is created: a revoke or narrowing in between is `PermissionDenied`.

A refusal creates no task, no worktree, no mirror row, no label and no event. A worktree that cannot be made (the branch
already exists, the checkout fails) removes the task it was about to give to the package and answers `Conflict`,
`NotFound` or `HostUnavailable` without the host's text.

## Defaults, bots and channels

`resolveDefaults` gives, in order: the request's own choices, what a bot or channel project pins (`Pinned`: harness,
model, mode, effort, and the `bot` and `channel` identity it keeps), then the user's defaults. What a project pins
belongs to its pinned harness: a request that names another harness takes none of it. The main window supplies `pinned`
only for what the app already holds; a project with no pin starts on the user's defaults.

A task started here is a plain task: the user's saved default team is not applied (a package that wants a team starts the
task and then uses `tasks.configure`, R0404). The first message is sent through the composer's own path.

## Attribution

`TaskOrigins` (file-backed `task-origins.json` next to the grants file, independent of SQLite, schema untouched) keeps the
package id and its display name per task id, at most 10,000 (the oldest label goes first). The label survives the
package: an uninstalled package's tasks keep its name. The window reads `extensions_runtime_task_origins` and the event
`extensions-runtime-task-origins`, and `mountTaskOrigins` puts a chip with the package name after the title of every
sidebar row (the sidebar rows are also the history: completed tasks stay listed there) and a line "Started by <package>"
beside the breadcrumb of the open thread. `task.created` carries `startedBy: { package: <id> }`. A deleted task loses its
label (`task_removed`).

## Bounds (predictability and fault isolation, never trust)

Four starts per package waiting for the window's defaults (`LimitExceeded`), 15 s for that answer, 200,000 bytes of
prompt, 200 characters of title, 16 attachments, 10,000 labels. A service that ends (disable, revoke, uninstall, safe
mode, crash, quit) cancels its waiting starts; they create nothing and answer `Revoked`.

## Refusal-test reconciliation (Q090, Q115)

Q090 and Q115 named package task starts as refused for lack of a permission. This slice changes the specific permissioned
assertions: a package that holds `tasks.start` for the project now starts a task; a package without the grant, with the
grant narrowed away from the project, or whose package is disabled still gets `PermissionDenied`. Retained refusals and
their non-security reasons: unknown project/harness/target (`NotFound`: nothing to act on), a signed-out or missing
harness (`HostUnavailable`: the harness cannot run), shape and size bounds (input validation, predictability), a
waiting-start cap (fault isolation). Pairing a machine and granting remote access remain absent by design (the user's
decision, not a security limit on the package: trust in the author is not trust in another machine).

## Evidence columns

Preview/model: `tests/extensions-runtime-tasks-start.spec.ts` (ports 16201 Chromium, 16202 WebKit). Native unit tests:
`runtime_tasks_start::tests`. Installed service starting the scripted ACP agent (`fake-agent.mjs` over B5, declared by
`sample.launch-agent`, R0801) and a real attribution in the sidebar: the final test phase and R1212 qualification.
