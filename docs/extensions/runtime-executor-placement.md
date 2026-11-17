# Services beside remote and headless executors (R0108)

Runtime phase R1, slice R0108. A package declared `extensionKind: "workspace"` (or `"split"`) acts for the tasks of
the computer that executes them, so its background service ([runtime-service-lifetime.md](runtime-service-lifetime.md))
runs on that computer, including a headless host (`pandacode serve`, [../headless.md](../headless.md)). The desktop
shows those services, with their host, and steers them through PandaCode Connect ([../remote-access.md](../remote-access.md)).

Native: `src-tauri/src/extensions/runtime_executor_placement.rs`. Webview: `src/extensions/runtime-executor-placement.ts`
(mounted as "On other computers" on the Extensions page). Fixture: `tests/fixtures/extensions/runtime-executor-placement/`.

## Placement rule

| Executor | `ui` package | `workspace` / `split` package |
| --- | --- | --- |
| Desktop (this computer executes the task) | service runs | service runs |
| Headless host (`pandacode serve`) | never starts (no window for its code) | service runs |
| Another computer executes the task | presents the mirrored task only | only that computer's copy acts for it; this computer never runs it instead |

`ServiceLifetime::reconcile` intersects its grant check with `services_here(snapshot, this_executor())`; before R0108 a
headless host started no service at all. `route(manifest, remote_device)` states the per-task rule
(`Here`, `Executor(device)`, `Presentation`). A task started on a host by another device publishes `task.created` on
that host (`remote/start.rs`), so the host's service sees it as it would a local one. Nothing copies a package, its
data or a credential between computers: the package must be installed and trusted on the host by the user.

## Remote methods (host side)

Registered as the `extensions` group of the Connect registry (`remote/methods/mod.rs`, declared in the runtime file,
not in `remote/methods/`, so the upstream inventory of [upstream-remote.md](upstream-remote.md) is unchanged). The
device grant gates each call before it runs; the package's own grants are decided by the host's grant store.

| Method | Device grant | Read-only | Params | Answer |
| --- | --- | --- | --- | --- |
| `extensions.services` | view | yes | `{apiVersion: 1}` | `{schemaVersion, host {deviceId, name, platform, headless}, safeMode, services[], activity[], ui {revision, owners}, revision}` |
| `extensions.serviceControl` | control | no | `{id, op: "stop" \| "retry", requestId}` | `{id, op, applied, requestId, attribution {package, deviceId, host, from}, service}` |
| `extensions.serviceGrant` | full | no | `{id, op: "grant" \| "revoke" \| "revokeAll", permission?, scope?, requestId}` | same shape |

- Rows list the host's installed workspace-kind packages (at most 128): state, held, working, status line, restarts,
  last stop, Stop/Retry availability, declared and granted permissions, and `attribution {package, deviceId, host}`.
- `activity` (at most 64, oldest first) is attributed per package: `hook` (recorded by the harness hook slices through
  `record_activity`), `ui`, `control`, `grant`, `lifecycle`. `ui.owners` counts each package's live items (R0205) and
  notices (R0207). Summaries are display text, bounded to 200 characters, control characters removed; nothing secret.
- Idempotence: the host remembers each writer's answer by calling device and `requestId` (256 answers, 10 minutes) and
  answers a repeat with the first answer plus `replayed: true`. Stop of a service the user already stopped answers
  `applied: false`. Retry clears a stop, a failed start or a parked service and reconciles. A granted
  `runtime.service` starts the service; a revoked one ends it with the stop reason `trust`.

## Desktop side

- `extensions_executor_services` (main window): one entry per paired host computer of the account other than this one
  (at most 16, asked concurrently, 8 s each). An offline computer, a computer that does not know the method or an
  answer that is not attributed to the computer asked is listed `reachable: false` with the reason; its services are
  not shown and nothing runs here instead.
- `extensions_executor_service_control` / `extensions_executor_grant` (main window): one request id per click; a call
  that timed out or lost its connection (it may have run) is retried once with the same id, so a reconnect never
  applies a change twice. The answer must name the package and the computer asked (`StaleContext` otherwise).
- The Extensions page rereads every 2 s while open. Pairing a computer, approving a device and its access level stay
  with the user in Remote settings; nothing in this slice pairs, approves or changes a device's access.

## Evidence levels

| Level | What it proves | Where |
| --- | --- | --- |
| Fake paired transport | protocol only: attribution, strict reading, idempotent writers across a lost reply, refusals, unavailable hosts pending | `runtime_executor_placement::tests` (`FakeTransport`), `tests/extensions-runtime-executor-placement.spec.ts` (preview stand-in) |
| Native fixture | a real service beside a headless executor (Windows x64, pinned runtime): projected with the host identity, stopped and held, retried, ended by revoke | `runtime_executor_placement::tests::installed` (feature `extension-runtime-native-tests`) |
| Installed cross-machine | actual service host identity, revoke and stop between two real paired computers | **pending**: needs two machines the user already paired; never claimed by code (`QUALIFICATION`) |

Cross-machine procedure (for the qualification run, with the user's paired computers): install and trust the fixture
on the host computer and on the desktop; on the desktop open Extensions, "On other computers": the row must name the
host computer and `where` (the fixture command) run there must report the host's name and platform; Stop from the
desktop must end the process on the host and keep it stopped; revoking `runtime.service` from the desktop must end it
with `trust`; taking the host offline must show it unavailable and leave placement pending.

## Retained refusals (Q024, Q085, Q111, Q130)

| Row | Retained refusal | Reason it stays (not security) |
| --- | --- | --- |
| Q024 `ui_only_packages_never_register_workspace_execution_even_when_trusted` | a `ui` package registers no workspace execution and starts no service on a headless or remote host | Predictability: the author declared that the code runs where the window is; a headless host has no window. The permissioned behaviour delivered is the workspace-kind service beside the executor (`reconcile_on_a_headless_executor_starts_only_the_workspace_service`). |
| Q085, Q111 (R0108 part) `pairing`, `link-confirm`, `unlink` controls of `panda.machines` | `InvalidArguments` from package metadata | Product decision (binding): pairing a machine and granting remote access stay with the user; they are irreversible trust decisions about a device, not package powers. `remote-start`, `orchestration`, `behind-continue` and `target-device` belong to R0406C (packages starting and directing tasks on other machines). Unauthorized, stale and foreign-owner denials in those rows are kept. |
| Q130 `extensions remote: ${fallback} peer refuses execution …` | a legacy or missing peer starts nothing and nothing runs locally | Predictability and irreversibility: work runs on the host and provider the user captured and is never retargeted to this computer. The positive half is delivered here: a qualified host runs the workspace package beside its executor. |
| Foreign, `ui` or unknown package in the remote methods | `NotFound` | Predictability: only the host's own workspace-kind packages are placed beside its executor. |
| Undeclared permission / name outside the vocabulary | `PermissionDenied` / `UnsupportedCapability` | The closed vocabulary and the install declaration (ADR-0005); the host's grant store decides as on the desktop. |

No retained refusal restricts a trusted package that holds the matching permission.

## Handoffs

- Hook activity: the harness hook slices (R05) call `record_activity(owner, ActivityKind::Hook, summary)` on the
  executing computer; the desktop shows it attributed under the service row.
- A package starting or directing a task on another computer from package code: R0401/R0404/R0406C.
- Installed WebView and two-machine qualification: R1212.
