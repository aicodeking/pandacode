# Running services and the quit confirmation (`runtime.service`)

The Extensions page has a **Running** section. It lists the background services of your extensions
([runtime-service-lifetime.md](runtime-service-lifetime.md)) with their state, restarts, memory, status line, running
jobs and the computer they run on, and it has Stop, Retry and Data size controls. When a service says it is working,
quitting PandaCode names it in the quit question. This page is runtime slice R0107.

## What the list shows

Everything comes from native state; nothing is measured twice:

| Field | Source |
|---|---|
| State, start reason, restarts, last stop, counters | `ServiceLifetime::projection` (R0104) |
| Crashes, scheduled restart, parking explanation, slow start | its `supervision` object (R0106) |
| Memory (resident set of the whole process tree, and its peak) | `supervision.memory`, sampled every 2 s (R0106) |
| Status line and `working` | the service's last `lifetime.setStatus({ text, working })` |
| Running jobs | `ExtensionJobs::running`, each job once, on its package |
| Host | `{ placement: "local", name, platform }`: always this computer here |

The native owner is `src-tauri/src/extensions/runtime_service_status.rs` (`extensions_service_status`, main window
only, not in headless mode). It is declared through `#[path]` inside `runtime_service_lifetime.rs` until `mod.rs` is
free, like the other runtime slices. The webview reader, the list and the preview stand-in are in
`src/extensions/runtime-service-status.ts`. The open list rereads the state once a second while the page is visible,
so state, memory, restarts and the working text update without any action.

```json
{ "schemaVersion": 1, "available": true,
  "host": { "placement": "local", "name": "DESKTOP-1", "platform": "windows" },
  "counts": { "services": 2, "working": 1, "jobs": 3, "quit": 2 },
  "services": [ { "id": "sample.service-status", "state": "running", "held": false, "restarts": 0,
    "status": { "text": "Indexing 3 files", "working": true }, "working": true, "jobs": 2,
    "memory": { "residentBytes": 41943040, "peakBytes": 45088768, "samples": 12 },
    "host": { "placement": "local", "name": "DESKTOP-1", "platform": "windows" },
    "controls": { "stop": true, "retry": false }, "…": "the lifetime and supervision fields" } ],
  "jobs": [ { "id": "sample.tools", "running": 1 } ],
  "quit": [ { "id": "sample.service-status", "text": "Indexing 3 files", "jobs": 2 },
            { "id": "sample.tools", "text": null, "jobs": 1 } ] }
```

**Counting.** Each service is one row and each running job is counted once, on its package. `counts.services` is the
services that have a process (starting, running or stopping); `counts.working` those that report `working: true`
while they start or run; `counts.jobs` every running owned tool job; `counts.quit` the packages the quit question
would name. Jobs of a package without a service are listed under `jobs`, so every counted job is visible.

**Placement.** This slice only shows services on this computer, with the same computer name Connect uses. Services
beside remote and headless executors are R0108; nothing here says where such a service runs.

## Controls

| Control | Shown when | What it does |
|---|---|---|
| Stop | starting, running or restarting | `extensions_service_stop`: the service gets `onStop("stop")`, has 2 s, and its process tree ends. A scheduled restart is cancelled. The service then stays **stopped by you** (`held: true`): another reconcile, a grant change, a crash timer or an update do not start it |
| Retry | failed, parked, restarting, or stopped by you | `extensions_service_retry`: clears the hold, the failed start, the parking or the scheduled restart with a clean crash history, and reconciles (`runtime_service_lifetime::retry_app`). The service starts with the reason `enable` when it is still enabled, trusted and granted |
| Data size | always | `extensions_service_data_size`: the size of the package's data directory `<app data>/extension-data-v1/<id>` (the one `panda.storage.directory` hands out, R0105). Regular files only; links are neither followed nor counted; at most 100,000 entries are visited, then the result says `truncated` |

Enabling the package again is also a retry, as before. Disabling, uninstalling or losing trust stops the service for
its own reason; disabling or uninstalling also ends the hold, so the next enable or install starts it normally (safe
mode does not end it). A stop by the user counts `stops.stop` and sets `lastStop` to `{ reason: "stop", acknowledged }`
(`acknowledged: false` when Stop cancelled a scheduled restart, since no process ran its `onStop`).
Stopping something that has no process (a failed or parked service, or one already stopped) answers `Conflict`; an
unknown package answers `NotFound`.

## The quit confirmation

`src-tauri/src/quit_guard.rs` holds the one quit account (`QuitAccount`): the running local agents, then the extension
packages still working, each package once. A package is working when its service reports `working: true` while it
starts or runs, when it owns running tool jobs, or both
(`runtime_service_status::quit_packages`, the single extension input; S0608 consumes this seam and adds no second
counter). The app's `ExitRequested` handler asks when the account is not empty, with the same rules as before
(never headless, never after the user confirmed, never while shutting down, never for an update restart).

- With no package working, the question and its wording are exactly the original's:
  `2 agents are still running. Quitting stops them.`
- With working packages, each is named once with its status line and its running jobs:
  `1 agent is still running. Extension still working: sample.service-status (Indexing 3 files; 2 jobs running). Quitting stops them.`
  The status line is shown on one line, without control characters, cut at 80 characters.
- When the service clears its work (`setStatus({ text, working: false })`), stops or ends, it is no longer named, and
  with nothing else running PandaCode quits without asking. The account is taken when the user asks to quit; a dialog
  already shown is not rewritten.

The Running section shows the same sentence while something is working: "Quitting now asks first. Extension still
working: …".

## Tests

- Native, always: `runtime_service_status::tests` (counting services and jobs once, the quit packages and clearing
  the work, the controls of each state, the data size of the package's own directory with its bound and the link
  rule, Stop refused without a process, Retry of a failed start, the fixture's validity), `quit_guard::tests` (the
  original wording without packages, naming once, the dialog line rules) and
  `jobs::tests::running_jobs_are_counted_once_per_owner`.
- Native, real runtime (`--features extension-runtime-native-tests`, Windows x64): the fixture
  `tests/fixtures/extensions/runtime-service-status/` is installed for real and connects to the canonical B1 fake
  daemon. B1 signals named `status` change its working state. The test checks the running row (state, restarts,
  measured memory, this computer), the data size of the file it keeps, the quit account while working and after the
  work is cleared, Stop with `onStop("stop")` and the hold across reconciles, and Retry.
- Browser preview: `tests/extensions-runtime-service-status.spec.ts` in Chromium and WebKit. The preview runs no
  package code: its rows come from the lifetime and supervision stand-ins, and the working state, memory, jobs and
  data sizes are scripted by a labelled stand-in (preview-only commands `extensions_service_status_preview` and
  `extensions_service_quit_preview`).

## Refusals kept (ADR-0005 dispositions)

None of these limits what a trusted service may do; they keep the user's controls predictable:

- Stop and Retry are the user's controls in the main window only (`PermissionDenied` elsewhere and in headless mode),
  like the lifetime projection. A package has no API to stop or hold another package's service.
- A data size request for something that is not a package id (`..`, a path separator) is `InvalidArguments`: the
  control measures the package's own data directory, never an arbitrary path.
