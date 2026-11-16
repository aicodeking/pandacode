# B3 fake cloud

Start `node fake-cloud.mjs [--identity-port 0] [--api-port 0]` with stdin open.
Read one stdout line `{ready:true,identity,api,control}`. All addresses are
numeric loopback with independent OS-selected ports. Only port 0 is accepted.
`startCloud()` returns `state`, `ready`, `close()` and `done` without starting
anything when imported. `core/fake-cloud.mjs` is transport-free and takes
injected S256, time and token generators.

Identity: `GET /authorize` takes response_type=code, client_id, numeric HTTP
loopback redirect_uri, nonempty state, code_challenge, method S256 and scope.
Modes: approve redirects with code/state, deny with access_denied, bad-state
with altered state, hang never answers, page displays manual-path instructions.
The page does not auto-complete: set approve and reopen the original URL.
`POST /token` takes URL-encoded authorization_code fields and validates client,
exact redirect and S256 verifier. A successful code is consumed once, including
concurrent exchange. Bad verification does not consume it.

Refresh uses `grant_type=refresh_token`, `refresh_token`, `client_id`. Access
tokens last 60 s. Refresh defaults to keeping the refresh token; set
`/control/mode {refresh:"rotate"}` to replace and invalidate it. Every access
and refresh token is a random `tok-` canary. `GET /userinfo` requires a valid
bearer and returns `dev@example.test`.

API: authenticated `GET /v1/models` returns two fixture models. `POST /v1/chat`
accepts `{model,messages,stream:true}` and returns SSE delta frames, a usage
frame and `[DONE]`. Deltas concatenate to `echo: <last user message>`, unless
overridden. `GET /v1/usage` accepts a valid bearer or any nonempty `tok-` API-key
canary in `x-api-key`. No real account or key provisioning is needed.

Controls, available on either listener: POST `/control/mode {authorize?,refresh?}`,
`expire` (all current access tokens), `revoke` (access and refresh),
`rate-limit {count,retryAfterMs}` (next count chat calls: 429 with
`retry-after-ms`), `reply {text}`, `usage {windows,credits?}`, `fault {kind,ms?}`,
`reset`, `shutdown`. GET `log` gives every request, listener, headers and body.
All paths above have `/control/` prefix. Fault garbage returns invalid JSON;
stall leaves data requests unanswered; refuse disconnects their sockets; drop
closes current connections except its own control request. Recovery does not
replay a request. Reset restores default windows/modes and clears credentials.

Stop with shutdown, stdin EOF or termination; hung requests also close.
Sign-in provider (6): all authorize/exchange/stream/expiry/refresh/revoke/rate
paths are controllable. Usage band (7): custom header and changing windows are
controllable. Host single-flight refresh, account switching, token redaction,
UI/permissions and polling cadence require later product tests. Raw logs retain
canaries intentionally so those later tests can inspect the request boundary.

Test: `node --test fake-cloud.test.mjs` (four tests).
