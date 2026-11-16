# Workspace events for background services

Slice R0202. A trusted package with `runtime.service` and the `events.workspace` grant can listen to what happens in
the workspace: tasks, turns, projects, settings and window focus. Events arrive over the duplex channel of its
service ([runtime-duplex-channel.md](runtime-duplex-channel.md)), in order, and carry ids only.

## What a package sees

```js
exports.service = async (panda, lifetime) => {
  const subscription = panda.events.on('turn.finished', async event => {
    // event: { schemaVersion: 1, kind, sequence, at, taskId, projectId, index }
  });
  lifetime.onStop(() => subscription.dispose());
};
```

`panda.events.on(kind, handler)` returns a `Disposable`. `kind` is one of the thirteen events or `gap`.

| Kind | Fields beside `schemaVersion`, `kind`, `sequence`, `at` |
|---|---|
| `task.created` | `taskId`, `projectId`, `harness`, `startedBy` (`'user'`, `'bot'`, `'schedule'`, `'team'` or `{ package }`) |
| `task.removed`, `task.idle`, `task.compacted` | `taskId`, `projectId` |
| `task.shown` | `windowId`, `taskId` or null, `projectId` or null |
| `task.stopped` | `taskId`, `projectId`, `by` (`'user'` or `{ package }`) |
| `turn.started`, `turn.finished`, `turn.failed` | `taskId`, `projectId`, `index` |
| `project.opened`, `project.closed` | `projectId` |
| `settings.changed` | `page`, `revision` (a settings page of this package) |
| `app.focus` | `focused` |
| `gap` | `dropped`: events were lost; read the state again |

- **Ids only.** The host refuses to publish an event with any other field. Content needs the matching read
  permission (`tasks.transcript.read` and the others) or the hooks.
- **Scoped.** `events.workspace` is narrowable per project. An event of a project outside the grant is never queued,
  and is checked again when it leaves the queue, so narrowing the grant stops delivery at once. Events that belong to
  no project (`app.focus`, a `task.shown` with no task, `settings.changed`) need only the grant. `settings.changed` is
  only for the package whose page changed.
- **Ordered.** `sequence` counts the envelopes of one service process, starting at 1, gap markers included, and is
  assigned when an envelope leaves the queue, so a consumer sees every number once and in order. Handlers of one
  event finish before the next event reaches any handler; a failing handler never stops the stream.
- **Bounded (predictability, not trust).** At most 256 events wait for a service. When the 257th arrives the oldest
  is dropped and one `gap` event (`dropped` is the count, however many were lost since the last one) is delivered
  before the newer events. A service that listens to `gap` reads the state again with `panda.context.query`; one that
  does not still loses nothing but the dropped events. The service process applies the same bound to its own handlers:
  a handler that cannot keep up sees one `gap` whose `sequence` is the last number it covers.
- **No listener left behind.** The subscription exists only while the process runs. Restart, disable, uninstall,
  update, loss of trust or of the grant, and safe mode (which starts no service) all leave zero listeners and nothing
  queued; a new process begins empty. Disposing the last handler of a kind tells the host, which discards the queued
  events of that kind.
- **Refusals.** Subscribing without the grant answers `PermissionDenied` and the kind stays without listeners; a name
  that is not an event answers `InvalidShape` (nothing would ever arrive on it).

## Wire format

Host to service, one way, never answered: `{"event": {schemaVersion, kind, sequence, at, ...}}`, a frame of the duplex
channel. Service to host (a request like any other of the service): `events` with `{op: "subscribe" | "unsubscribe",
kind}`, answered with the broker envelope. Events do not use the 64-call bound or the request rate, because they are not
calls; the writer keeps 64 slots free for answers and calls while events drain, and events that do not fit stay queued
(where the 256 bound and the gap apply).

## Files

- `src-tauri/src/extensions/runtime_workspace_events.rs`: shape check, per-service queue, gate, gap, sequence (pure).
  `WorkspaceEvents::publish` is what the app calls; `publish_app` is the helper that finds it from an `AppHandle`.
- `src-tauri/src/extensions/runtime_service_lifetime.rs`: the process loop (`events` requests, draining, attach and
  detach) and the grant gate installed by `reconcile_app`.
- `src-tauri/src/extensions/node-host.cjs`: the service side (`panda.events.on`, ordered pump, own 256 bound).
- `src/extensions/runtime-workspace-events.ts`: the same rules for the browser preview and the deterministic spec.
- `tests/fixtures/extensions/runtime-workspace-events/`: the fixture service.

## Not here

`panda.events.on` in a panel answers `UnsupportedCapability` (a handler must outlive a panel).

## Where the app reports each event

All producers call the helpers of `runtime_workspace_events.rs` (`publish_app` underneath) and never fail the thing
that happened:

| Event | Reported from |
|---|---|
| `project.opened`, `project.closed` | `add_project`, `remove_project` (`lib.rs`) |
| `task.created` (`startedBy: 'user'`) | `create_session` |
| `task.removed` | the delete command, after the task is gone |
| `turn.started` | the run start, with the next turn index of that task |
| `turn.finished`, `turn.failed`, `task.stopped`, `task.idle` | the run end (a user stop is `task.stopped`; `task.idle` follows every end) |
| `task.compacted` | the agent event sink: a provider's completed "Compact context" step, once per step |
| `task.shown` | `extensions_workspace_task_shown`, called by the window when the shown task changes (main window only) |
| `app.focus` | the main window's focus event |
| `settings.changed` | not reported yet: it needs the package settings pages (`panda.settings.get`, a later slice) |

Tasks started by a bot, a schedule, a team or another package are reported as `startedBy: 'user'` until the slices
that start them (R3) name their starter.
