# Background services (`runtime.service`)

A trusted package can keep one long-lived service process. It is how a package holds a socket to a local daemon,
runs a timer or keeps state across tasks. This page covers the lifetime: when a service starts, what stops it and
what the host promises. It is runtime slice R0104. Supervision (restart with backoff, parking), the Running list,
the user's environment and code folders, and the duplex channel are separate slices, listed at the end.

## Declaring a service

```json
{
  "permissions": ["ui.contribute", "runtime.service"],
  "runtime": {
    "kind": "node", "entrypoint": "main.cjs",
    "activationEvents": ["sample.service-lifetime/long"],
    "service": { "start": "onEnable" }
  }
}
```

```js
exports.service = async (panda, lifetime) => {
  const timer = setInterval(poll, 5000);
  lifetime.onStop(reason => clearInterval(timer));
  await lifetime.setStatus({ text: 'Watching the daemon' });
};
```

- `service.start` has one value, `"onEnable"`. Any other value is `InvalidShape`.
- Declaring a service requires `runtime.service` in `permissions`. Without it the manifest is refused with
  `PermissionDenied` at `$/<n>/permissions`. Both validators (`contracts.ts` and `contracts.rs`) check this, and
  `tests/fixtures/extensions/contracts-v1.json` holds the refusal cases.
- The SDK types are `Service`, `ServiceLifetime`, `ServicePandaCode`, `ServiceStartReason` and `ServiceStopReason`
  in `src/extensions/sdk/index.d.ts`.
- The legacy shapes stay refused. A top-level `entrypoint` or `activationEvents` is still `UnsupportedRuntime` with
  the "Declarative-only:" reason, and so are install `scripts`. The reason is stability: there is one runtime
  descriptor, and no code runs before the user's consent.

## When it runs

The native owner is `src-tauri/src/extensions/runtime_service_lifetime.rs` (`ServiceLifetime`, Tauri state). One
rule decides which services should run: `desired`, mirrored by `desiredServices` in
`src/extensions/runtime-service-lifetime.ts`. A service runs only when all of these hold:

- the app is not in safe mode and is not a headless host (executor placement is R0108);
- the package is installed and enabled;
- its executable content is trusted, meaning the archive digest the user reviewed;
- it declares `runtime.service.start: "onEnable"`;
- `RuntimeGrants::check(id, version, "runtime.service")` passes (the native grant, R0101).

No service starts before trust. Enabling an untrusted package is already refused with `ExecutableTrustRequired`,
and a trusted, enabled package without the grant starts nothing.

| Start reason (`lifetime.reason`) | When |
|---|---|
| `appStart` | First reconcile of the app, run on a blocking task from `setup_common` |
| `enable` | Enable, a new grant, an explicit retry, leaving a stop that no longer applies |
| `update` | The archive digest changed while the service ran and the new content is still wanted. The old process ends first, so there is one service per package |
| `restart` | Reserved for crash restarts (R0106) |

| Stop reason (`onStop(reason)`) | Trigger |
|---|---|
| `disable` | The package is disabled |
| `uninstall` | The package is no longer installed |
| `update` | A different archive digest is selected, or the update no longer declares a service |
| `trust` | Executable trust is revoked, or the `runtime.service` grant is revoked, narrowed out or archived |
| `safeMode` | Safe mode (including recovery from a compact window) |
| `quit` | The app quits: `ExitRequested` asks every service to stop and waits up to 2.5 s before exit. `RunEvent::Exit` asks too, and the job object ends anything left |
| `stop`, `park` | Reserved for the Running list (R0107) and supervision (R0106) |

Reconcile is triggered from the existing package seams: `runtime::stop` (disable, uninstall, untrust, rollback,
safe mode, recovery), `runtime::package_changed` (a promoted update), `runtime::retry` (enable, development reload)
and `extensions_runtime_grant`. A revoked grant also stops the service by itself: each service holds a
`RuntimeGrants::begin` work item and checks it every 50 ms.

To stop a service, the host sends `{stop: reason}`. The bootstrap runs every `onStop` handler, acknowledges with
`serviceStopped` and exits. The host waits at most 2 s (`STOP_GRACE`). After that it always terminates the job
object and reaps the child, so helper processes the service started end with it.

## What the host promises

- **It never delays the app.** `reconcile` only spawns work, so callers never wait on a process. A service function
  that never settles stays `starting`.
- **A broken service stays visible.** A service that throws or exits on its own is `failed` with an error code. The
  package stays enabled, and no other change restarts it. Enabling it again is the retry; automatic restarts with
  backoff come with R0106.
- **It never uses a short-activation slot.** Services are not in `ExtensionRuntime::active`, so they never count
  against the eight short activations. A command of the same package still runs as its own short activation beside
  the service.
- **It survives task switches.** A service is not owned by a window or a captured context. Releasing a context,
  switching tasks or closing the main window's presentation leaves it running.
- **No deadline, no heap cap, no message budget.** The 64 KiB frame bound stays. The job object keeps
  kill-on-close but sets no memory limit, because memory is measured (R0106), not capped.
- **Command handlers share the service's state.** `panda.commands.register(id, handler)` inside a service accepts
  the package's own `runCommand` ids, and the handler lives in the service's state. Dispatching invocations into it,
  with context queries and host events, is R0201's duplex channel. Until then, a command runs as a short activation.

## Reading the state

`extensions_service_lifetime` (main window only) returns:

```json
{ "schemaVersion": 1, "available": true, "services": [
  { "id": "sample.service-lifetime", "version": "1.0.0", "state": "running", "reason": "appStart", "restarts": 0,
    "status": { "text": "…", "working": false }, "error": null,
    "starts": { "appStart": 1 }, "stops": { "quit": 1 }, "lastStop": { "reason": "quit", "acknowledged": true } } ] }
```

`state` is `starting`, `running`, `stopping`, `failed` or `stopped`. Each package's counters are kept for the life
of the app, and `stops` also counts `crash`. The browser preview's stand-in (`createServiceLifetimePreview`, wired
in `src/extensions/preview.ts`) follows the same rule and counters. It runs no package code, and a main-page reload
counts as quit plus launch.

## Tests

- Native, always: the rule tables, the descriptor and legacy refusals, and "nothing before trust, enable and grant;
  reconcile never waits; a failed start stays failed until retried".
- Native, real runtime (`--features extension-runtime-native-tests`, Windows x64): the fixture
  `tests/fixtures/extensions/runtime-service-lifetime/` is installed for real and connects to the canonical B1 fake
  daemon (`tests/fixtures/extensions/backends/fake-daemon`). The test signals B1, switches tasks, and runs the
  3-second long command as a short activation. It then stops the service for every reason, checks the counters and
  the `start:`/`stop:` reasons the service wrote into B1, and checks that no host or helper process survives a stop.
  A second test covers hanging and throwing services.
- Browser preview: `tests/extensions-runtime-service-lifetime.spec.ts` in Chromium and WebKit.

## Later slices

R0105: code folders, the inherited user environment (the service still gets the short activation's cleared
environment) and `storage.directory`. R0106: restart with backoff, parking, start-state timing and memory. R0107:
the Running list, stop/retry controls and naming working services on quit. R0108: services next to remote and
headless executors. R0201: the duplex channel, command dispatch into the service, and context queries.
