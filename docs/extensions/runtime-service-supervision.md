# Service supervision (`runtime.service`)

A background service ([runtime-service-lifetime.md](runtime-service-lifetime.md)) is supervised by the host. A
crashing service is restarted with backoff, and after repeated crashes it is parked with an explanation. A slow
start is reported but never waited for, and memory is measured but never capped. This page is runtime slice R0106.
These are reliability rules (ADR-0005): none of them limits what a running service may do.

## Rules

The rules are pure functions in `src-tauri/src/extensions/runtime_service_supervision.rs`, mirrored for the webview
in `src/extensions/runtime-service-supervision.ts`. `ServiceLifetime` applies them in its service loop
(`runtime_service_lifetime.rs`).

| Rule | Value |
|---|---|
| A crash | The process started, then exited on its own, threw from `service`, or broke the protocol |
| Not a crash | A start that never reached a process (no runtime, unreadable code). It stays `failed` until it is retried |
| Restart delay | 1 s after the first crash, doubling per consecutive crash: 1, 2, 4, 8, 16, 32, then 60 s at most |
| Consecutive | Each crash comes less than 10 minutes after the previous one. A crash 10 minutes or more after the previous one starts again at 1 s |
| Parking | The fifth crash inside a 10-minute window parks the service. A crash exactly 10 minutes after the oldest one no longer counts it |
| Slow start | A service whose `service` function has not settled after 10 s is reported as a slow start (`startup.slow`). Nothing waits for it |
| Memory | The resident set of the whole process tree (the job object's processes on Windows, `VmRSS` on Linux), sampled every 2 s, with its peak. There is no limit, no heap flag and no deadline. macOS reports `null` until its runtime is qualified |

A restarted service starts with `lifetime.reason === 'restart'` and `lifetime.restarts` equal to the number of crash
restarts since the user last started it. Every crash ends the whole process tree before the restart (the job object
is terminated and the child reaped), so a crash never leaves a helper process behind.

A parked service gets this explanation: `The service of <id> was parked after 5 crashes in 10 minutes
(HostUnavailable x5). Retry, enable or update the package to start it again.` It holds the package id, the number of
crashes and the host error codes, most frequent first. It never includes package output, and it is cut to 240
characters. Parking counts `stops.park` and sets `lastStop` to `{reason: "park", acknowledged: false}`. The process
has already ended, so no `onStop` handler runs for it.

## What restarts or cancels a restart

- **Retry, enable and update start a parked service again**, with a clean crash history. Enable is the retry
  (`runtime::retry`, also used by development reload). An update with a changed archive digest starts it with the
  reason `update`. Retry also clears a scheduled restart (the service starts at once) and a failed start.
- **Disable, safe mode, uninstall, loss of trust or of the grant, and quit cancel a scheduled restart.** The entry is
  removed, and the timer that was waiting finds nothing to restart.
- **Nothing else restarts a parked service.** Another reconcile, a grant change or time passing leave it parked.
- **Unrelated work keeps running.** Each service is supervised on its own. Another package's service, the agent tasks
  and the app never wait for a crashing, restarting, parked or slow service.

## Reading the state

`extensions_service_lifetime` adds two states and one object to each service:

- `state` can be `restarting` (a crash restart is scheduled) or `parked`, besides `starting`, `running`,
  `stopping`, `failed` and `stopped`.
- `supervision`:

```json
{ "crashes": 2, "backoffMs": 2000, "restartInMs": 1400, "parked": null,
  "startup": { "elapsedMs": 812, "slow": false, "readyMs": 640 },
  "memory": { "residentBytes": 41943040, "peakBytes": 45088768, "samples": 12 } }
```

`crashes` counts the crashes inside the current 10-minute window. `backoffMs` and `restartInMs` are set while
`restarting`, and `parked` holds the explanation while `parked`. `startup` is set while `starting` or `running`, and
`memory` after the first sample. The Running list that shows these fields is R0107.

## Clock

The supervisor reads time from a `Clock`: the real monotonic clock in the app, and a `ManualClock` in native tests.
A test advances it explicitly, so the backoff, the parking window and the slow-start boundary are exact to the
millisecond. The browser preview's stand-in (`createServiceSupervisionPreview`) uses a simulated clock as well.

## Tests

- Native, always: `runtime_service_supervision::tests`. They cover the scripted crash sequences (1, 2, 4, 8 s, then
  parked; crashes 150 s apart climbing to 60 s without parking; the 599,999 ms and 600,000 ms boundaries; the reset
  after 10 quiet minutes), the explanation and its bound, the slow-start boundary, the manual clock and memory
  measurement.
- Native, real runtime (`--features extension-runtime-native-tests`, Windows x64): the fixture
  `tests/fixtures/extensions/runtime-service-supervision/` crashes on command under a `ManualClock`. The test checks
  that each restart waits exactly its backoff, the fifth crash parks, an unrelated service keeps running, no host or
  helper process survives a crash, and retry, enable and update restart the parked service. It also checks that
  disable and safe mode cancel a scheduled restart, a hanging start becomes slow after 10 s without delaying
  reconcile, and memory is measured.
- Browser preview: `tests/extensions-runtime-service-supervision.spec.ts` in Chromium and WebKit. It uses a labelled
  stand-in with scripted crashes, because the preview runs no package code.

## Refusals kept (ADR-0005 dispositions)

- Q035 (`one_hundred_supervised_cycles_with_crash_injection_leave_no_child_processes`): kept for short activations,
  for fault isolation: no process survives an activation. For services this slice adds the permissioned behaviour,
  restart after a crash, and proves that every crash still ends the whole tree.
- Q121 (`extensions runtime: real native ${fault} …`): the `Timeout` of a short activation's `loop` and `timeout`
  faults is kept, for predictability: a short activation has a deadline, and the core stream and typing never wait
  for it. A service has no deadline. A service that never settles is reported as a slow start instead.
