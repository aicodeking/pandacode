# Run coverage and harness capabilities (runtime slice R0509)

Native owner: `src-tauri/src/extensions/runtime_harness_coverage.rs`. Preview twin:
`src/extensions/runtime-harness-coverage.ts`. Fixtures: `tests/fixtures/extensions/runtime-harness-coverage/`
(`matrix.json`, the expected capability row of every harness; `scenarios.json`, one scenario per traced launch path,
the mirrored task and the counters the report must show after them; `extension.json` + `main.cjs`, the reader package
`sample.coverage-reader`). Spec: `tests/extensions-runtime-harness-coverage.spec.ts` (preview/Node column). Native:
`runtime_harness_coverage::tests`.

Hooks (R0503) are delivered from the turn that starts in `launch_operation_admitted` and from the agent event sink.
This slice answers two questions an author has before relying on them: **which runs reach those seams**, and **what
each harness lets a hook see**, in every mode, with how each fact is known.

## Which runs are covered

There is no single runner. Every path below was traced to the seam that starts its turn and the seam that reports its
events; where nothing told the hooks what kind of run it was, a seam was added.

| Run kind | Trigger | Starts the turn (`launch`) | Reports its events (`events`) | How the kind is known |
|---|---|---|---|---|
| `task` | `user` | `send`: `send_prompt` / `start_task` / `launch_task` → `launch_operation_admitted` (`lib.rs`) | `agentEvents`: `emit_coalesced` → `runtime_hook_registration::agent_event` | default |
| `task` | `package` | `tasksStart`: `runtime_tasks_start` / `runtime_tasks_messages` → `send_prompt` | `agentEvents` | the task-origins ledger (`package` in the run) |
| `task` | `tool` | `agentTool`: `pandacode_start_task` / `pandacode_send_message` (`agent_tools.rs`) | `agentEvents` | **new seam**: launch scope `LaunchOrigin::Tool` (`parentTaskId`, `tool`) |
| `worker` | `team` | `teamWorker`: the lead's dispatch → `launch_operation_admitted` with a team admission (`worker_launch`) | `agentEvents` | the worker flag; `parentTaskId` and `workerId` from `architect_workers` |
| `worker` | `council` | `teamWorker`, a worker with a Council seat | `agentEvents` | the seat (`lens`) |
| `bot` | `bot` | `botWorkspace`: `bots/gateway.rs` (direct, team and queued turns), `bots/failover.rs`, shared channels | `agentEvents` | the store: the task lives in a bot's workspace project (`botId`) |
| `bot` | `remote` | `remoteRequest`: a paired device drives a bot's thread | `agentEvents` | bot workspace, then the launch scope (`deviceId`) |
| `schedule` | `schedule` | `scheduleFiring`: `schedules/firing.rs` → `send_prompt` | `agentEvents` | **new seam**: launch scope `LaunchOrigin::Schedule` (`scheduleId`) |
| `remote` | `remote` | `remoteRequest`: any request of a paired device (`remote/host.rs` `handle`, on a desktop host or a headless `pandacode serve`) | `agentEvents` | **new seam**: launch scope `LaunchOrigin::Remote` (`deviceId`); `executor` is `desktop` or `headless` |
| `remote` | `remote` | `remoteStart`: `task.start`, `team.start`, `chat.start`, `github.startTask`, which run in a spawned task (`start_keyed_bound`) | `agentEvents` | **new seam**: the same scope re-entered inside the spawned start |
| `remote` | `cloud` | `cloudRun`: `cloud_agents` starts and re-attaches (`attach_cloud_run`) | `agentEvents` | the store: the task has a cloud machine (`executor: 'cloud'`) |
| `remote` | `mirror` | `mirrorSend`: this desktop sends to a task that runs on another computer (`remote/mirror.rs` `send`) | `mirrorEvents`: **new seams** in `mirror.rs` `show` (mirrored approvals and tool rows) and `finish` (the turn end) | `hostId` is the computer that runs it; `executor: 'remote'` |

Precedence when several apply: a team worker is `worker` whatever started its lead; a bot's thread is `bot` whatever
delivered the message (the trigger says what did); then a schedule, a paired device, a cloud machine; an agent tool's
or a package's start is a `task` with that trigger. The launch scope is a task-local value (`within(origin, launch)`):
it reaches a turn started inside the awaited launch, never one spawned elsewhere, so a stale scope cannot mislabel a
later turn.

`HookRun` (the `run` of every payload): `{ kind, trigger, executor, parentTaskId?, workerId?, lens?, botId?,
scheduleId?, deviceId?, hostId?, tool?, package? }`. `match.runs` filters on `kind`.

### A task that runs on another computer

The desktop has no harness process for it, so no companion can be used there: hooks see what the host computer sends.

- `prompt.submit` and `turn.start` when this desktop sends the prompt; a turn the host started (its own user, another
  device) starts here with its first sign of work, without `prompt.submit`.
- `tool.before` for each permission request the host shows (source `permissionRequest`, coverage `askedCalls`; the
  input is the request's `data.input` as the host sent it). The request is decided on the host; a decision returned by
  a desktop package goes nowhere (deliveries are observe only).
- `tool.after` for each finished tool row (source `activity`, coverage `afterOnly`: the request and the row carry
  different ids, so they are not paired), `compaction` for a finished "Compact context" step.
- `turn.finish` / `turn.fail` and `task.idle` when the host's run ends here.

The capability report lists this path with `toolBefore: { source: 'permissionRequest', companions: 'unavailable' }`.

## Counters

While any hook is attached, every launch is counted by run kind and trigger, and every reported occurrence by run
kind, event and source (`host` for events without one). With no hook attached nothing is counted and nothing changes.
The counts are part of the report (`runs[].counters`), so one scenario per run kind can be compared with it: that is
what the spec and the native test do with `scenarios.json`.

## `panda.harnesses.list`

```js
const report = await panda.harnesses.list();                    // every harness
const codex = await panda.harnesses.list({ harness: 'codex' }); // one row
```

Under `harnesses.inventory`, checked natively per call (`PermissionDenied` without it; `HostUnavailable` for a package
that is not enabled and trusted). Options are strict: `{ harness?, includeModels?: false }`; another key or type is
`InvalidShape`, `includeModels: true` is `UnsupportedCapability` (models stay with the context inventory), an unknown
harness `NotFound`. The answer:

```ts
{ schemaVersion: 1, decisions: 'observeOnly', harnesses: HarnessCapabilities[], runs: RunCoverage[] }
```

One row per built-in harness of the roster (`PROVIDERS`) and per provider of an enabled, trusted package. Every
capability is a cell with a `qualification`:

| Qualification | Meaning |
|---|---|
| `sourceFeasible` | Established from documentation or source reading only |
| `recorded` | Proved by frames recorded in the repository's protocol tests, or by fake fixtures |
| `installedQualified` | Proved by a separately authorized capture on an installed harness. None exists; no row claims it |
| `unsupported` | Not available on this path |

- `hooks.toolBefore[mode]`: what reaches `tool.before` today, per mode. `source: 'permissionRequest'` with coverage
  `askedCalls` (the calls the harness asks about) or `escalationsOnly` (sandbox escalations only), or `source: null`,
  `coverage: 'none'` (no request arrives: the call is seen only by `tool.after`). `can` is `[]` while deliveries are
  observe only; `sourceCan` is what that source can carry once decisions are delivered. `feasible` lists other
  sources: a per-run `companion` (`everyCall`) and, in `full`, `askAtHost` (keep the harness asking and answer at the
  host), each `sourceFeasible` until qualified.
- `hooks.toolAfter`: always `activity` / `afterOnly`; `inputComplete` says whether the complete input reaches it
  (Claude Code family, ACP harnesses, package providers), `feasible` what a companion could do to a result.
- `hooks.hostTools`: the tools PandaCode serves itself (`pandacode_*`) reach the hooks after the fact today;
  `feasible` is `hostTool` / `everyCall` for every harness that receives the tool server (not ZCode).
- `hooks.promptSubmit`, `hooks.turn`: from the host for every harness. `hooks.compaction`: `after` where the adapter
  reports a finished compaction (Claude Code family, Codex), else `none`; `feasible` what a companion could change.
- `toolServers`, `compact` (`request` / `command` / `none`), `denyReason`, `rewriteInput` (what a permission answer
  carries, R0502), `companion` (`sourceFeasible`, `unknown` or `none`, with its mechanism), `evidence` (`frame`,
  `spike`, `documentation`).

The only bare booleans are facts whose parent cell is qualified (`toolServers.value`, `rewriteInput`,
`toolAfter.inputComplete`); a capability is never a single yes or no, because coverage differs per mode and source
(Codex, Devin, Muse and DeepSeek ask only about part of what they do).

`runs[]`: per run kind, its traced `paths` (`trigger`, `launch`, `events`, `toolBefore.companions`: `perHarness`, or
`unavailable` for the mirrored path; `delivered` events; `qualification: 'recorded'` by the fake scenarios) and its
`counters`.

The expected values are in `matrix.json`; both implementations are tested against it, and the spec checks that the
twin's roster, recorded harnesses and paths are the native ones.

## Columns and limits

- Preview/Node: the spec (both Playwright configurations, CI ports 16411/16412) runs the twin against the shared
  fixtures and drives `main.cjs` through a stand-in of the service SDK. Native fixtures: `runtime_harness_coverage::tests`
  (the matrix, qualified cells, every scenario's `HookRun`, the launch scope, one replay per run kind plus the mirror
  compared with the counters, strict options and the roster). Installed qualification: none; remote and cross-machine
  qualification, live companion captures and platform evidence stay evidence gates (R0606 extends the report with
  version-specific companion fixtures).
- Mode coverage comes from documentation and source reading (PLAN-harness-capabilities); only the frame shapes of the
  `recorded` harnesses are recorded, not every mode's asking set.
- A launch that is spawned off its request (outside the awaited future) is not inside its launch scope and reports
  `task`; the traced spawn (`start_keyed_bound`) re-enters the scope. A schedule firing that queues behind a busy turn
  is delivered later by the queue and reports `task` (trigger `user`).
- A mirrored turn's `prompt.submit` is missing when the host's events reached this desktop before the send returned.
- Counters count only while a hook is attached, since the app started; they are not persisted.
