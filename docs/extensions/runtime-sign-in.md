# Browser sign-in (`auth.signIn`)

A trusted package whose service needs an authorization code from an identity provider asks the host to run the
browser part of the sign-in. The host listens on numeric loopback, opens the authorization address in the system
browser, shows a notice with Cancel and hands the service the whole callback address. The package then checks the
state value, proves its key and exchanges the code itself, and keeps what it gets with
[`secrets.private`](runtime-private-secrets.md). It is runtime slice R0803 (contract G24).

```js
exports.service = async (panda, lifetime) => {
  panda.commands.register('sample.sign-in/connect', async () => {
    const result = await panda.auth.signIn({
      authorizeUrl: `${identity}/authorize?response_type=code&client_id=sample&redirect_uri={redirect_uri}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`,
      callback: { path: '/callback' },       // optional port (a registered client needs a fixed one) and host
      timeoutMs: 120000,                     // default 120000, 1 to 900000
      manual: true,                          // offer "Paste the redirect address"
      title: 'Sample cloud',                 // shown in the notice; defaults to the package id
    });
    if (result.status !== 'completed') return;            // 'cancelled' or 'timeout'
    const code = new URL(result.url).searchParams.get('code');   // the package exchanges it and stores the token
  });
};
```

Fixture: `tests/fixtures/extensions/runtime-sign-in/`. Types: `ServicePandaCode.auth` in `src/extensions/sdk/index.d.ts`.

## Rules

| Rule | Behaviour |
| --- | --- |
| Who can call | A background service holding `auth.signIn`. A panel gets `UnsupportedCapability` (the answer carries an authorization code). |
| Listener | Numeric loopback only (`127.0.0.1`) on `callback.port`, or a free port. `callback.host` (`127.0.0.1` or `localhost`) only chooses how the address is written in `redirectUri`. `{redirect_uri}` in `authorizeUrl` is replaced by the percent-encoded address. |
| Browser | One function, `open_browser`, opens `authorizeUrl` (http or https, no user info). Tests pass another opener; nothing else replaces it. |
| Callback | One `GET` at `callback.path` ends the flow; the browser gets a short "you can close this tab" page. The host does not read the query: `url` is the whole callback address. A request for another path (a favicon) is answered `404` and the flow keeps waiting; an empty connection is ignored. |
| Answer | `{ status: 'completed', url, redirectUri, via: 'callback' \| 'manual' }`, `{ status: 'cancelled' }` or `{ status: 'timeout' }`. Cancel, timeout and completion are statuses, not errors. |
| Notice | While a flow waits the webview's projection (`extensions_sign_in`, main window only) lists `Waiting for sign-in: <title>`, the phase, the time left and Cancel. It never carries a callback address or any query; with no browser it carries the authorization address to copy. |
| Manual path | With `manual: true`, at the end of the wait the listener is closed and the flow stays open for two more minutes as a paste dialog (`extensions_sign_in_paste`); a pasted address must be the loopback address the host wrote, at the callback path, and resolves with `via: 'manual'`. Without `manual` the wait ends as `timeout`. With no browser available (`open_browser` fails) a `manual` flow keeps waiting for a paste; without `manual` the call answers `HostUnavailable`. |
| One flow | A second sign-in of the same package while one waits is `Conflict`, as is a `callback.port` something else holds. A refused call opens no browser and binds nothing. Different packages may wait together on their own ports. |
| Disposal | Revoke, narrowing, untrust, disable, a stale version and safe mode end the flow with `PermissionDenied`; a request on the callback that is not a `GET` request line (garbage, another method, an absolute-form target) ends it with `InvalidShape`. Every end drops the listener and removes the notice. |
| Logging | Nothing of the flow is logged: not the address, the query or the code. |

## Errors

`PermissionDenied`, `UnsupportedCapability`, `InvalidArguments` (anything outside the documented options, an address
that is not http(s) or has user info, a path with a query or space, a port outside 1 to 65535, a timeout outside
1 to 900000, a title over 120 characters), `Conflict`, `InvalidShape`, `HostUnavailable`.
`Revoked` is in the contract's shared enum but not yet in the native one: a revoked flow answers `PermissionDenied`,
as every other runtime call does today.

## Why there is no stricter check on the callback

ADR-0005 keeps protections for fault isolation and predictability only. The host does not compare a state value or a
host header: the package that started the flow owns the proof (state, proof key, exchange), and the listener lives
for one flow, on loopback, until the first valid request, cancel, timeout or disposal. The malformed-request rule
exists so that a flow never sits behind a half-read connection.

## How it is checked

- Native: `runtime_sign_in::tests`: the callback flow, stray requests, cancel, timeout, the manual path, the second
  flow and the taken port (no listener leaks: the port binds again), revoke/disable/untrust/stale version, malformed
  callbacks, option validation and no-browser. On Windows two tests run the B4 fake browser through the B3 fake
  identity server (`tests/fixtures/extensions/backends/`): the flow completes, the test plays the package, exchanges
  the code with its proof key and stores the token through `PrivateSecrets`, then checks that neither the
  projection nor any panel-visible value holds the code or the token. A user who never finishes ends as `timeout`
  (the fake browser in `record` mode captures the address that was opened).
- Browser preview: `tests/extensions-runtime-sign-in.spec.ts` in Chromium and WebKit. The preview has no listener or
  browser: it follows the same rules on a simulated clock and simulated ports, with flows started from a test hook.

## Remaining

The service-process request `panda.auth.signIn` is not yet routed to the host: the duplex channel
(`runtime_duplex_channel.rs`) dispatches the calls it knows, and `auth.signIn` and `panda.secrets.*` join it when the
service dispatcher gains its family routes. `SignIns::sign_in` is the entry that dispatcher calls (on a blocking
task, with `open_browser` as the opener). The webview notice component that reads `extensions_sign_in` is a
presentation task; the projection, Cancel and Paste commands it needs are here.
