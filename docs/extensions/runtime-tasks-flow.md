# Councils, workers and usage-limit pauses (`tasks.control`)

A trusted background service decides a Council with `panda.tasks.council`, steers one worker of a team with `panda.tasks.worker`
and answers a usage-limit pause with `panda.tasks.limit`. Each call is a thin adapter over the operation the interface already
runs for the same choice, with the same refusals, and is labelled with the package's name. Stop, mode, configure and compact are
the earlier slice ([runtime-tasks-control.md](runtime-tasks-control.md)); this page is the rest of `tasks.control`.

```ts
panda.tasks.council(taskId: string, decision: 'accept' | 'dismiss' | 'keepFixing'): Promise<null>;
panda.tasks.worker(taskId: string, workerId: string, action: 'retry' | 'resume' | 'skip' | 'stop'): Promise<null>;
panda.tasks.limit(taskId: string, action: 'continue' | 'resume' | 'dismiss', options?: { connection?: string; harness?: string }): Promise<null>;
```

## Permission

`tasks.control`, **per project** (the task's project), the same grant as stop and configure. It is granted with the trust
decision, listed at install, rechecked on every request (twice: at admission and again just before anything changes, so a revoke
or a narrowing in between changes nothing), revocable and narrowable by the user. Revoking or disabling blocks the next call and
ends the rounds the package was waiting on; it never touches another package's calls or another task. A package that holds it is
never asked per action (ADR-0005). No credential is involved (ADR-0006): `connection` names an id from the connections list,
never a value.

None of the six operations is an irreversible deletion, and the interface asks no confirmation for any of them (Accept and
finish, Keep fixing, the strip's close button, the banner's Continue, Resume at reset and its dismissal), so there is no host
confirmation to keep or to switch off per package: the call and the button are equally direct.

## What each call runs

| Call | Interface operation | Notes |
|---|---|---|
| `council` `accept` | `architect_council_accept` ("Accept and finish") | Council stays on and the strip reads "Accepted at ..."; the lead may finish |
| `council` `keepFixing` | the follow-up to the lead the strip's Keep fixing sends (`Keep fixing until every reviewer reaches the target.`) | Held by the main window: it sends it as a queued message is sent, and the prompt's draft is never touched. A running lead answers `Conflict` (`ids: ["running"]`) |
| `council` `dismiss` | the settled strip's close button (hidden until the next cycle) | Held by the main window, which keeps the dismissed cycles |
| `worker` `stop` | one worker's run stopped; it settles as `stopped` | As the team's Stop does for every worker; a scored or running Council reviewer is never unseated |
| `worker` `skip` | the worker is abandoned, its sub-workers settle with it | As the lead's `cancel_worker` does, so the team can finish; a skipped worker can still be followed up by the lead |
| `worker` `retry` (a failed worker) and `resume` (a stopped one) | the worker is queued again; a failure uses one attempt, a stop does not | As the team's Resume queues it. A running team takes the one worker back (`architect_worker_control`); a paused, failed or interrupted team takes the team's own Resume (`architect_control`), which queues **every** stopped and failed worker, as the Resume button does |
| `limit` `continue` | the banner's Continue: the follow-up `Continue where you left off.` | Held by the main window. `options.connection` moves the task to another connection of its harness first (the banner's "Continue on ..." choice) and says so in the follow-up. `options.harness` may only name the task's own harness: the interface offers no other harness on a limit (`UnsupportedCapability`, path `harness`) |
| `limit` `resume` | the "Resume at reset" switch (`set_resume_at_reset`, on) | The pause must carry its reset time (`Conflict`, `ids: ["noReset"]`) |
| `limit` `dismiss` | the banner's dismissal (`clear_usage_limit`) | A team held by the limit goes at once, as it does for the button |

The commands of each action are plain data (`plan` in `runtime_tasks_flow.rs` and `runtime-tasks-flow.ts`, one twin each), so a
recording of the interface's own calls compares equal to what an action runs:
`tests/fixtures/extensions/runtime-tasks-flow/parity.json` is read by the browser spec and by `runtime_tasks_flow::tests`.

## The interface has no per-worker button

The interface controls a team as a whole (Stop, Pause, Resume on the panel) and the lead controls one worker with its own tools
(`followup_worker`, `cancel_worker`). The worker calls give a package the one-worker effect by the same rules, in
`runtime_tasks_flow_workers.rs` (a child module of `architect`, declared there, so it uses the team store and the Council seat
rules the parent keeps private). A paused team is the exception that keeps the interface's behaviour exact: retry and resume then
run the team's own Resume, whose effect on the other stopped and failed workers is the Resume button's.

## Windows and headless

`keepFixing`, `dismiss` and a limit `continue` need the main window (the queue, the per-cycle dismissal and the connection move
live there). The host asks it through the event `extensions-runtime-task-flow` and the window answers through
`extensions_runtime_task_defaults_answer`, the channel a start's defaults and a Run on choice already use (at most four waiting
rounds per package, 15 s, and a service that ends cancels its rounds as revoked). In headless mode these answer
`UnsupportedCapability`; the host's own operations (accept, the worker calls, limit resume and dismiss) work.

## Attribution

Every successful flow is kept in the same control ledger as R0404 (`ControlLog`: task, `council`/`worker`/`limit`, the call and
the commands that ran, package id and name, time; bounded to 1,000). The thread header draws the latest ("Controlled by Flow
controller").

## Refusals

| Code | When |
|---|---|
| `PermissionDenied` (path `tasks.control`) | no grant, a revoked grant, a disabled package, a task of a project outside the narrowed scope (a cross-task id included); also an unknown task id while the package holds the permission for no project at all |
| `NotFound` | unknown task or worker (path `workerId`); a connection that is not an alternative of the task's harness |
| `Conflict` | the state the interface needs for the same button is missing: no team, Council off, a lead that is running (keepFixing), a worker that is not in the state the operation takes (path `op`), a reviewer (never retried), a finished team, a task that is not limited, no reset time. `ids` names the reason |
| `UnsupportedCapability` | a task mirrored from another computer (its team and its pauses are that computer's); another harness; a connection on a mirror; a window round in headless mode |
| `HostUnavailable` / `Timeout` / `Revoked` | the window did not answer in time, or the service ended while it waited |
| `InvalidShape` | unknown field or action, a missing or out-of-set `decision`, `workerId`, `op`, `options` on anything but a continue |

The refusals that remain are for predictability and fault isolation; none is a security restriction on a package that holds the
permission.

## Refusal-test reconciliation (Q rows owned here)

The listed rows assert that the declarative, host-choice paths (a contributed panel, dock or roster control with an id such as
`council-accept`, `council-dismiss`, `council-keep-fixing`, `stop-worker`, `retry`, `skip`, a transcript-extras usage-limit action)
cannot carry task authority. R0404B changes none of those files, so no assertion in them changes; what it delivers is the
**permissioned** path beside them: a package that holds `tasks.control` decides a council, steers a worker or answers a pause
through the three calls above, from its running service. The contributed controls stay refused because they have no service and
no per-call grant check: they are manifest surfaces whose actions run only the host's own handlers on a fresh host choice
(R0407 for the roster and panels, R0505 and R0507 for the dock and approvals).

| Rows | Delivered by R0404B (permissioned assertion) | Retained refusal and its non-security reason |
|---|---|---|
| Q003, Q069, Q096 (composer panels: the eleven controls incl. `council-accept`, `council-dismiss`, `council-keep-fixing`, `council-set`; protected location) | `council` `accept`, `dismiss`, `keepFixing` through the service | the contributed controls stay refused: their layout, order and visibility are R0402/R0407's host choice, and `council-set` (the Council settings) is `workspace.settings`, not a flow |
| Q005, Q071, Q098 (thread extras: the eight controls incl. the usage-limit actions; protected location) | `limit` `continue`, `resume`, `dismiss` through the service | the contributed usage-limit actions stay refused: captured host-choice actions of R0203/R0407 with no service behind them |
| Q013, Q079, Q105 (action dock: `stop`, `stop-worker`, `approve`, `deny`, `answer`, `retry`, `skip`) | `worker` `stop`, `retry`, `skip` (and `resume`) through the service | the dock controls stay refused (`InvalidArguments`, `stop_session` and `respond_approval` never called): a dock click is a host choice (R0505/R0507); approvals and answers are `harness.hooks.decide`, not `tasks.control` |
| Q014, Q080, Q106 (agent roster: `stop`, `stop-subagent`, `approve`, `answer`, profile and widget probes; fields `name`, `response`, `tools`) | `worker` `stop` for a team worker | the roster controls, the profile edits and the fields stay refused: R0407 owns the roster, and a worker's name, response and tools are prompt content that never crosses the package boundary |

Foreign-owner, stale-revision and forged requests in those rows are retained as they are: they protect predictability (an action
is applied to the thing the user saw) and are not a restriction on the permissioned path, which has no captured handle to go stale.

## Limits

- Tests are written for the browser preview column and as native unit tests; the installed service against a real harness is
  not claimed (separate column, needs a harness run that requires explicit authorization).
- The preview has no service: the spec drives the deterministic twin (`FlowController`) and the window half through
  `window.__runtimeTaskFlow`, answering into `window.__runtimeTaskDefaultsAnswers`.
- A worker `skip` or `stop` while the team is not running changes the worker only; the lead learns of it at its next turn.
