# Hooks declared, attached and observed (runtime slice R0503)

Native owner: `src-tauri/src/extensions/runtime_hook_registration.rs`. Preview twin:
`src/extensions/runtime-hook-registration.ts`. Fixtures: `tests/fixtures/extensions/runtime-hook-registration/`
(`extension.json` + `main.cjs`, the observer package `sample.hook-observer`; `declarations.json`, the validation cases
both validators run; `replay.json`, a `synthetic` B5-shaped replay with two projects, two run kinds and two harnesses).
Spec: `tests/extensions-runtime-hook-registration.spec.ts` (preview/Node column). Native:
`runtime_hook_registration::tests`.

A package declares its hooks in the manifest, its background service attaches handlers with `panda.hooks.on`, and
the host delivers normalized, content-bearing events to them inside the package's `harness.hooks.observe` grant and
the declaration's `match` filter. In this slice every delivery is **observe only**: decisions (`tool.before`),
context and prompt changes (`prompt.submit`), result rewrites and compaction answers are R0504/R0505, chains and
failure policies R0506.

## Declaration

```json
"permissions": ["runtime.service", "harness.hooks.observe"],
"runtime": { "kind": "node", "entrypoint": "main.cjs", "service": { "start": "onEnable" } },
"contributes": { "hooks": [
  { "id": "sample.guard/before", "event": "tool.before", "onFailure": "ask", "budgetMs": 2000,
    "match": { "toolKinds": ["shell", "edit"], "harnesses": ["*"], "runs": ["task", "worker"] } },
  { "id": "sample.guard/after", "event": "tool.after", "match": { "extensions": [".ts", ".rs"] } }
] }
```

The schema (`$defs/hookDeclaration`, `$defs/hookMatch`) bounds the shape: `event` is one of the thirteen hooks,
`onFailure` one of `continue`, `ask`, `deny`, `budgetMs` an integer from 100 to 120,000, `match.toolKinds` from the
seven kinds, `match.runs` from the five run kinds, `match.harnesses` built-in ids, package provider ids or `*`,
`match.extensions` lowercase-insensitive extensions with their dot. The event-dependent rules are one semantic check,
`runtime_hook_registration::check` (native, called by `contracts.rs`) and `checkHookDeclarations` (twin, called by
`contracts.ts`), in the same order, so both validators answer the same first refusal (`declarations.json` is the
shared corpus):

| Rule | Refusal |
|---|---|
| Hooks need a background service to attach them (`runtime.service`) | `UnsupportedRuntime` at `contributes/hooks` |
| Id `panda.*` / not `<package>/…` / repeated | `ReservedId` / `InvalidId` / `DuplicateId` |
| One declaration per event | `DuplicateId` naming the event |
| `onFailure`: `ask` and `deny` only for `tool.before`, `deny` also for `prompt.submit`, `continue` elsewhere | `InvalidShape` |
| `budgetMs` only where a handler may answer: 100–30,000 for `tool.before`/`tool.after`, 100–10,000 for `prompt.submit`/`save.before`, 100–120,000 for `compaction`; none on events nothing waits for | `InvalidShape` |
| `match.toolKinds` only on tool events; `match.extensions` only on tool events and `save.before`; no repeated entry | `InvalidShape` / `DuplicateId` |
| The receiving permission is declared: `harness.hooks.observe` (every event but `save.before`), `documents.editors` (`save.before`) | `PermissionDenied` at `permissions` |

Defaults: `onFailure: "continue"`, `budgetMs: 2000`. The declaration is shown at install with what happens when the
hook fails (R0506 applies it).

## Attaching (`panda.hooks.on`)

```js
const hook = panda.hooks.on('tool.after', call => { /* observe */ });
hook.ready.catch(error => console.log(error.code)); // UnknownReference, PermissionDenied, HostUnavailable
hook.dispose();
```

`hooks.on` returns the usual synchronous `Disposable`, with a `ready` promise that settles when the host accepted the
registration: the host checks it natively (`hooks` request, `{ op: 'register', event }`):

- an event that is no hook answers `InvalidShape`;
- an event the manifest does not declare answers `UnknownReference`;
- a package without the receiving permission answers `PermissionDenied` (granted later, it registers again);
- a package that is disabled, untrusted or in safe mode has no running service, so nothing registers.

A refused registration attaches nothing. Several handlers of one event share one registration; disposing the last one
unregisters the event (`{ op: 'unregister', event }`). When the service process ends for any reason (stop, crash,
disable, uninstall, update, safe mode, revoked `runtime.service`) every hook of the package is removed with it
(`service_stopped`, from the service lifetime's ended hook).

While any hook is attached, built-in runs record complete tool inputs (`runtime_hook_payload::set_observed`); with
none, a run does exactly what it did before this slice and the app's reports return at once.

## Delivery

| Event | Reported where | Payload |
|---|---|---|
| `prompt.submit` | `launch_operation_admitted` (`run_began`), when the run sends a user message | `HookTurn` |
| `turn.start` | the same place, right after | `HookTurn` |
| `tool.before` | the agent event sink, when a permission request opens for a call (`approval` events paired by R0502) | `HookCall`, `source: 'permissionRequest'`, `coverage: 'askedCalls'` |
| `tool.after` | the agent event sink, when a tool row reaches `completed`/`failed`/`cancelled`/`denied` | `HookCall` plus `status`, `output` (the interface's 8 KiB preview), `outputComplete`, `durationMs`, `decidedBy: null`; `source: 'activity'`, `coverage: 'afterOnly'` when no `tool.before` was reported |
| `compaction` | the agent event sink, a finished "Compact context" step | `{ taskId, projectId, harness, phase: 'after', can: [] }` |
| `turn.finish` / `turn.fail` | the end of the run (`run_ended`); a stop by the user ends the turn as `turn.fail` | `HookTurn` plus `transcript.cursor`, `durationMs`, `toolCalls` / `error.message` |
| `task.idle` | after either | `{ taskId, projectId, harness, turn, pending: { approvals: 0, questions: 0 } }` |

`HookCall` carries the complete input of `runtime_hook_payload` (structured up to 1 MiB, else a preview read in full
with `panda.hooks.input`), `tool.kind` from the native name table (`tool_kind`, then the input's fields), `shell` for
shell calls and `writePaths` for writes and edits. `HookTurn.text` is cut to the frame-safe 1 MiB. `can` is always
`[]` here.

Each delivery checks, natively and at once: the declaration's `match` (`harnesses` with `*`, `runs`, `toolKinds`,
`extensions` against the call's paths) and the package's grant for the run's project. A narrowed or revoked grant
stops delivery with the next event, without unregistering. The frame is a host call into the service
(`ServiceLifetime::send_hook`, `{ schemaVersion: 1, hookId, event, observeOnly: true, payload }`), which the node host
answers at once and then runs the handlers in order, one after another; the host never waits for it and never reads
what a handler returns. A service that cannot take the frame (stopped, restarting, parked, 64 calls pending) costs the
event, counted as failed; the run is never delayed or changed.

`panda.hooks.input({ callId, cursor })` (`hooksInput`) needs an attached hook and `harness.hooks.observe` for the
call's project; it answers `runtime_hook_payload::serve` (`NotFound`, `StaleContext`, `InvalidShape` as there).

## Observe only

The agent's normal path is the one it takes with no package: the permission prompt still appears and the user answers
it plainly (a decision a handler returns goes nowhere; the native test opens a request, delivers `tool.before` to a
service that "approves", and the adapter still claims the bare answer), the prompt is sent unchanged, the call and the
turn run on. Disposal, a revoked grant, disable and safe mode remove delivery and leave nothing behind.

## Columns and limits

- Preview/Node: the spec (both Playwright configurations; CI ports 16311/16312) runs the twin against the shared
  fixtures and drives `main.cjs` through a stand-in of the service SDK. Native fixtures: `runtime_hook_registration::tests`
  (the same corpus through `contracts::validate_contract`, the replay, refusals, observe only, removal). Installed
  service qualification (the real node host with `sample.hook-observer`, R1212): pending, not claimed.
- Run kinds: a team worker run is `worker` (`startedBy: 'team'`), a package-started task carries
  `startedBy: { package }`; bot, schedule and remote runs report `task` until R0509 traces run coverage.
- `tool.before` arrives only where a permission request opens (source C); companions and ask-at-harness (sources A,
  B) are R0505. Calls a harness never reports as a request arrive only as `tool.after`.
- `approval.*`, `question.*` (R0507) and `save.before` (documents) register already but are not delivered yet.
- `turn.finish` carries no `usage` yet; `task.idle.pending` counts are 0 (R0507 keeps pending requests).
- Delivery starts with the next turn after the first hook attaches (a turn already running has no facts recorded).
