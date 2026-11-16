# Duplex channel of background services

Slice R0201. A trusted package with `runtime.service` and the `runtime.service` grant has one long-lived process
(see [runtime-service-lifetime.md](runtime-service-lifetime.md)). This channel lets the host and that process talk at
the same time, over the pipe the process already has: the host dispatches the package's own commands into the
service, and the service asks the host for context, without either direction waiting for the other.

## What a package sees

- **Commands.** `panda.commands.register(id, handler)` in the service accepts only the package's own `runCommand`
  ids. When one of them runs (a menu, a shortcut, the command palette), the handler runs inside the service, in the
  state the service built, and receives `context.commandId` and `context.args`. The command does not start another
  process and has no deadline; the control that started it shows busy for at most five seconds.
- **Context.** `panda.context.query`, `subscribe`, `events` and `unsubscribe` exist in the service with the same
  behaviour as in a short activation. Requests made while an owned command runs are answered for the context that
  command was invoked from. A request made anywhere else (service start, a timer outside a command) is `StaleContext`,
  exactly as a released handle is for a short activation.
- **No manifest ceremony.** `runtime.activationEvents` may be left out when `runtime.service` is present. When it is
  listed it must still match the executable commands. Without a service it stays required.
- **Shutdown.** On disable, uninstall, update, loss of trust or of the grant, safe mode and quit, calls still
  outstanding settle with `Cancelled` and calls made afterwards with `HostUnavailable`. A crash settles with
  `HostUnavailable`. Nothing waits longer than the two second stop grace.

## Wire format

Length-prefixed frames: a 4-byte little-endian length, then one JSON object.

| Direction | Frame |
|---|---|
| service to host (request) | `{schemaVersion: 1, token, id, method, params}`; `id` counts up from 1 |
| host to service (answer) | `{id, reply: {ok, value}}` or `{id, reply: {ok: false, error: {code, ...}}}` |
| host to service (call) | `{call: {id, method: "command", params: {commandId, args}}}` |
| service to host (answer) | `{schemaVersion: 1, token, reply: {id, ok: true, value}}` or `{..., reply: {id, ok: false, error: {code}}}` |
| host to service (stop) | `{stop: reason}` (unchanged) |

A frame that is not exactly one of these shapes, has a wrong token, a wrong `schemaVersion` or a request id out of
sequence ends the service as a protocol failure (the service is restarted by R0106's rules, never silently kept).
A reply with an id that is unknown, already settled or late resolves nothing and is ignored; ids are never reused in
a connection, so it can never resolve another call.

## Bounds (predictability and fault isolation, not trust)

Per direction, so the host's calls never starve the service's requests or the reverse:

- **2 MiB** per frame body. Larger is `LimitExceeded` before the body is read (receiving) or before it is sent. A
  command whose arguments or result do not fit is refused or answered with `LimitExceeded`; the service keeps running.
- **64** calls pending. The 65th is `LimitExceeded` at once.
- **200 requests per second averaged over 10 seconds** (2000 in a sliding window). Over it, the one request is
  `LimitExceeded`.

A refused request or call never ends the service. Short activations keep their own 64 KiB frame and 16 pending limits.

## Files

- `src-tauri/src/extensions/runtime_duplex_channel.rs`: framing, correlation, bounds (pure, injected clock).
- `src-tauri/src/extensions/runtime_service_lifetime.rs`: the process loop (`ServiceLifetime::call_command`,
  `serves`, `set_dispatch`) that uses it.
- `src-tauri/src/extensions/node-host.cjs`: the service side (command dispatch, `panda.context`, 2 MiB frames).
- `src/extensions/runtime-duplex-channel.ts`: the same rules for the browser preview and the deterministic spec.
- `tests/fixtures/extensions/runtime-duplex-channel/`: the fixture service.

## What is not here

- Hooks, model tools, jobs, storage and dialogs inside a service, and notifications pushed to the service, belong to
  later slices; a service request for them answers `UnsupportedCapability`.
- Crash restart, parking and the Running list: R0106 and R0107.
