# The unstable internal interface (`internal.unstable`)

> **There is no compatibility promise.** `panda.internal.invoke` and `panda.internal.listen` reach host operations and events by
> name. The names, arguments and results change with any release or upstream merge, and an operation may be removed without notice.
> Use it only for a service that you update with the app. No reference package uses it, and nothing else in the SDK depends on it.

## What a service can do

```js
const info = await panda.internal.invoke('internal.info');          // { stability: 'unstable', commands, events, appVersion }
const listener = panda.internal.listen('internal.echoed', payload => { /* … */ });
await panda.internal.invoke('internal.echo', { n: 1 });              // answers { echo }, and the host raises internal.echoed
listener.dispose();
```

- `invoke(command, args?)` runs a host operation registered in the native table (`COMMANDS` in `runtime_internal_unstable.rs`).
  `args` is JSON of at most 64 KiB.
- `listen(event, handler)` is a bounded subscription: the service pumps it (every 100 ms), the host keeps up to 64 queued events per
  listener (the oldest goes first, and the next poll says how many were dropped), and a package holds at most 16 listeners.
  `dispose()` ends it. A throwing handler never ends the stream.
- The table holds inert operations today (`internal.info`, `internal.echo` and the event `internal.echoed`). A host module becomes
  reachable by adding one row; there is deliberately no generic router to every Tauri command, so private command names do not become
  an interface by accident.

## Rules

| Rule | Behaviour |
| --- | --- |
| Permission | `internal.unstable`, global. Listed at install, granted with the trust decision, rechecked natively on every call and again before an operation runs, revocable and never asked again per action (ADR-0005). |
| Refusals | No grant, revoked, disabled, untrusted, safe mode: `PermissionDenied` with the path `internal.unstable`. An unregistered name: `NotFound`. A shape the call does not take: `InvalidShape`. Over 64 KiB or 16 listeners: `LimitExceeded`. |
| Service only | A rich panel is a webview. `panda.internal` answers `UnsupportedCapability` there (`runtime_rich_channel::SERVICE_ONLY`). |
| Secrets | Names that denote a credential, token, secret, password, keychain, OAuth or sign-in answer `PermissionDenied` with the path `credentials`; no table row may return one (ADR-0006). A package gets its own secrets and host-run sign-in through their own calls. Nothing reaches the webview. |
| Attribution | Every call is written to the package's activity list: package, operation, name and outcome, never an argument or a result. The main window reads it with `extensions_internal_activity`; a panel cannot. |
| Lifecycle | Disable, uninstall, untrust, safe mode, a revoke and the service's end remove its listeners and queues (`service_stopped`, and the next poll). With no extension, all disabled or safe mode, nothing is registered and PandaCode behaves as the original. |
| Opt-in | No network, telemetry or recovery behaviour changes. Recovery dialogs stay built-in. |

Bounds (64 KiB, 16 listeners, 64 queued events, 200 activity lines per package) are for reliability and predictability, not safety.

## Refusal-test reconciliation (Q001, Q046, Q059)

The change this slice makes is the permissioned assertions only: a trusted, granted service invokes and listens; ungranted, revoked,
untrusted and panel callers are refused natively. The refusals below are retained, with their non-security reasons:

- Q001 and Q046: a declarative action of kind `bridge.call` (or the four task-control kinds) stays invalid. A manifest action is a
  declaration; it cannot hold a grant, be revoked or be attributed. The permissioned path is `panda.internal.*` from a service.
- Q059: `raw-ipc` stays an excluded data primitive. Primitives run without a package identity; `internal.unstable` is checked per call
  against the installed service's identity.
- Unauthorized, stale and foreign-owner denials stay: another package's listener cannot be polled or removed (`NotFound`).

## Evidence

- Native unit tests: `runtime_internal_unstable::tests` (request shape, gate order, invoke/listen end to end, revoke, foreign owner,
  bounds, activity list). Written, not run (deferred to the final test phase).
- Preview twin: `src/extensions/runtime-internal-unstable.ts`; browser spec `tests/extensions-runtime-internal-unstable.spec.ts`.
- Fixture: `tests/fixtures/extensions/runtime-internal-unstable/` (a service driven by one command).
- Installed, live qualification is pending: this column is not claimed.
