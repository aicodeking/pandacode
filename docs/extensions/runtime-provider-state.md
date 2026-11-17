# Dynamic provider state (`panda.providers.update`)

Runtime slice R0806. A package provider is declared once in the manifest. Its background service publishes what is
true now: readiness, the signed-in account's label, the models that account may use and its limits. Code:
`src-tauri/src/extensions/runtime_provider_state.rs` (native owner), `src/extensions/runtime-provider-state.ts` (the
webview reader and the labelled preview stand-in), the fixture `tests/fixtures/extensions/runtime-provider-state/`
and the spec `tests/extensions-runtime-provider-state.spec.ts`.

```ts
panda.providers.update(id, {
  readiness?: { state: 'ready' | 'signedOut' | 'unavailable'; reason: string };
  account?: { label: string } | null;
  models?: { id; name; efforts; contextWindow?; speedTiers? }[];      // at most 32
  limits?: { windows: { id; label; usedPercent; resetsAt? }[]; credits? } | null;   // at most 16 windows
}): Promise<null>
```

Permission: `ui.dynamic` (listed at install, rechecked natively on every call, revocable). Service only: a panel answers
`UnsupportedCapability`. No per-call confirmation (ADR-0005).

## Manifest additions

`contributes.providers[].metadata.signIn` and `.signOut` are `{ "command": "<id>" }` naming a command of the same
package. The host resolves them for the provider's "Sign in" and "Sign out" actions (`extensions_provider_action`); the
command runs in the package's service, which uses `panda.auth.signIn` (R0803) and `panda.secrets.private` (R0802) and
then publishes the outcome. A command the package does not declare is `UnknownReference`. `models` may be empty when
`metadata.signIn` is present (a launch provider may always be empty, R0801).

## Rules

- **One overlay, every reader.** The overlay is applied in `dynamic_harness::metadata` and `catalog` (the native roster,
  the model picker, the readiness line and the send path), in the `limits` and `accounts` resources
  (`runtime_usage_resources.rs`: published providers are valid `harness` selectors and add rows in the built-in row
  shape) and in the webview's `packageHarnesses` mirror. A readiness the service publishes is applied before the launch
  check, so an executable that cannot start still wins over a published `ready`.
- **Sign-out invalidates.** An update whose readiness is `signedOut` or `unavailable` empties the account, the models
  and the limits in the same step and ignores any such fields it carries. A not-ready provider cannot look ready.
- **A fault changes nothing.** A rejected update (bad shape, too large, unknown field) leaves the previous overlay and
  only increments `rejected`. The error codes are `InvalidShape`, `LimitExceeded`, `PermissionDenied`, `NotFound`.
- **Lifetime.** The overlay lasts as long as the service that published it. Stop, crash, disable, uninstall, update,
  trust loss, safe mode (`service_stopped`) and a revoked or narrowed `ui.dynamic` (`sweep_app`, after every grant
  change) return the provider to its manifest values.
- **Never starts anything.** Publishing and reading are pure data. A package is never started as a warm spare to
  refresh a roster (upstream 0.3.128's warm spares are suspected in a known deadlock, issue 382); a launched run still
  starts in `dynamic_harness::run`, on a send. The explicitly opted-in speed/warm-spare behaviour is R0807's, and it
  does not replace this owner.
- **Two tasks, one state.** All runs of one package share the single `runtime_provider_launch::State` (token manager,
  handshakes, readiness transitions) and read the one overlay; updates by any task land on the same entry.
- **No secret.** There is no field that can carry a credential: every shape is strict and every text is bounded; the
  projection (`extensions_provider_state`, main window only) and the roster carry labels, model ids, percentages and
  reasons, never a token. ADR-0006 stands: PandaCode's held credentials never reach the package, and the package's own
  token stays in `secrets.private`.

## Reads

- `extensions_provider_state` (main window): `{ schemaVersion, revision, providers: [{ id, owner, readiness, account,
  models, limits, updates, rejected }], recorder }`. The event `extensions-provider-state` says it moved; the native
  roster also emits `provider-models-changed { provider }`, which the model picker already follows.
- `extensions_provider_action { provider, action: 'signIn' | 'signOut' }` (main window): `{ command, owner }`.

## Columns

- Preview: `tests/extensions-runtime-provider-state.spec.ts` (labelled stand-in; the service's call comes from a test
  hook, `?provider-state`). Registered in both Playwright configurations and CI (ports 16161/16162).
- Native fixture: `runtime_provider_state::tests` (pure rules) and `installed::the_roster_picker_and_send_path_follow_fake_sign_in_and_sign_out_without_starting_the_package`
  (feature `extension-runtime-native-tests`, Windows x64): an installed trusted package whose launch provider starts
  signed out with no models, fills after a published sign-in, runs two concurrent tasks on the fake ACP agent over one
  launch state, refuses an unlisted model, invalidates at sign-out, and returns to the manifest on stop and disable.
  The fake identity server (B3) and fake browser (B4) flow itself is `runtime_sign_in::tests::with_fake_backends`.
- Installed/live app qualification: not claimed.

## Retained refusals (non-security reasons)

| Refusal | Reason |
|---|---|
| Foreign provider id, a built-in id, an undeclared provider: `NotFound` | ownership: a package publishes only providers its own manifest declares |
| A panel calling `providers.update`: `UnsupportedCapability` | a handler must outlive a panel; the call is service-only |
| Unknown field, over a bound, bad effort token, duplicate id: `InvalidShape` / `LimitExceeded` | predictability and stability of the roster the picker renders |
| Disabled or safe-mode package: `NotFound` | nothing may run for a package the user turned off |
| Stale or absent grant: `PermissionDenied` | the grant belongs to the installed version |

## Limits

- The service process's `panda.providers.update` request is routed through the app dispatch (`providerUpdate`) and
  compile-checked; the installed test calls the same `update` the dispatch calls, as R0803 did for sign-in.
- The usage view of the webview does not yet draw published limit windows for package providers (the `limits` resource
  and the roster metadata carry them); the picker's readiness line and models do follow.
- Handler (non-launch) providers run in a short activation and read the same overlay; running them inside the package's
  service is a later slice (A2 holds for launch providers' shared state and for the overlay).
