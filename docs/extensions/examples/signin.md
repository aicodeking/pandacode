# Example: the sign-in provider (an account-backed provider with a declared harness)

Task R1209. One installable package, `sample.signin` (`examples/extensions/signin/`), the reference example of the
authentication slices: browser sign-in ([sign-in](../runtime-sign-in.md)), the package's own secrets
([private secrets](../runtime-private-secrets.md)), provider state published from code
([provider state](../runtime-provider-state.md)) and a declared ACP harness ([provider launch](../runtime-provider-launch.md)).
It needs no panel and no hooks.

## What the package does

| Part | What it shows |
|---|---|
| Provider `sample.signin/cloud` | After install and enable it appears in the model picker as signed out, with a "Sign in" action (`metadata.signIn` names the command) and no model. |
| Sign in | `panda.auth.signIn` opens the system browser at the identity server's authorization address (state value and S256 challenge). The host listens on loopback and returns the whole redirected address; the package checks the state, exchanges the code, reads the account's e-mail and stores access token, refresh token and expiry in its own secrets. The provider becomes ready with the account label, the models the API returned and the limit windows from `/v1/usage`. |
| Cancel, timeout, conflict | Cancelling ends the flow as cancelled and stores nothing. After the configured wait the host offers "Paste the redirect address" (`manual: true`); a pasted address completes the sign-in (`via: 'manual'`). A callback with another state, or `access_denied`, shows a notice and stores nothing. A second flow while one is open is a `Conflict`, shown as a notice. |
| Refresh | A token is refreshed lazily, with one shared in-flight request per account: two callers that meet an expired token cause one refresh. A timer refreshes the active token shortly before it expires and republishes. |
| Revoked session | A refused refresh drops the account; with none left the provider returns to signed out ("Sign in again to use Sample cloud.") with its models, account and limits emptied, and the service stops asking. |
| Rate limit | One account: the service waits the time the API named and says "Rate limited, retrying in N s." More accounts: it switches to the next one and names both. |
| Accounts | Commands `Add a Sample cloud account` and `Sample cloud accounts` (a dialog that switches the active account or removes one). At most four accounts. |
| Sign out | Deletes the stored secrets and publishes signed out. |
| Settings | Page `sample.signin/settings`: identity address, API address, client id and the seconds to wait for the browser. |

## How the harness fits

The provider is a declared ACP harness (`launch`): the host starts the program on a send and speaks ACP to it, so the
package needs no adapter code. By ADR-0006 a token the package holds is never given to that program, in arguments or
environment; the service reads the account, models and limits itself and publishes them. Because the service publishes
one overlay per provider, two tasks on the provider see the same readiness and the same models, and a sign-out
changes both at once. The manifest's `__FAKE_AGENT__` stands for the ACP program (tests substitute B5, the reusable fake
agent); a real package puts its own CLI there. This example does not wrap the requests of a built-in harness, and it does
not pass its token to the launched program: a program that needs the account's token would need the host to attach it
(`credentials.use` on a connection request), which is a different package shape.

## How it is built

- `package/lib/signin.mjs`: all of the logic, one browser-safe ES module (no imports, no Node). It is handed `panda`, the
  lifetime and a small `io` (fetch, clock, sleep, timers, proof key) whose defaults are the platform's own.
- `package/main.cjs`: starts the module. `runtime.files` declares `lib`.
- Permissions: `ui.contribute`, `runtime.service`, `secrets.private`, `auth.signIn`, `ui.dynamic`, `ui.notify`.
- Tokens live only in the package's own secrets (one key, `accounts`, under the 16 KiB limit). No published value, notice,
  status line or dialog holds a token.

## Evidence

All of it is **prepared, not run (deferred to the final test phase)**; nothing here is an observation. The columns are kept apart
in `tests/fixtures/extensions/example-signin/evidence-columns.json`.

- Preview (both engines): `tests/extensions-example-signin.spec.ts` (grep `signin example:`; Chromium port 16681, WebKit
  16682) runs the shipped `lib/signin.mjs` in Node against B3's in-process identity and API, with the host's browser flow
  replaced by the call the real host makes, and the package's launch provider against B5 over stdio. It never proves the
  installed package or the real loopback listener.
- Native: not written by this task (it owns no Rust file); the plan is in the evidence file and follows
  `runtime_provider_state::installed` with B3 over sockets and B4 as the browser.
- Installed Windows: pending the installed app and the qualification opener.

## Limits

- The service's `panda.auth.signIn`, `panda.secrets.*` and `panda.providers.update` requests are compile-checked through
  the app dispatch and proven by direct native calls in their own slices; this package has not run against the host.
- The webview usage view does not yet draw published limit windows; the roster carries them.
- Account rotation moves the service's own reads; it does not switch a running harness task.
