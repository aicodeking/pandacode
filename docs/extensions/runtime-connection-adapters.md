# Declared connection requests and the JSON adapter (`connections.request`)

A trusted package declares a connection in its manifest and asks the host to run it. The host builds the HTTP request,
attaches the credential, runs it and hands back the answer; the package never names an address, a header or a
credential, and no credential value ever comes back to it ([ADR-0006](../../_work/10-docs/adr/0006-credentials-used-not-read.md)).
It is runtime slice R0804, on top of the private package secrets (R0802) and the duplex channel (R0201).

```json
"connections": [{
  "id": "sample.usage/api", "command": "sample.usage/report", "title": "Usage API",
  "authentication": "header", "headerName": "x-api-key",
  "credential": { "source": "secret", "key": "api-key" },
  "adapter": "json", "maxResponseBytes": 262144, "timeoutMs": 5000,
  "operations": [
    { "id": "usage",  "method": "GET",  "url": "https://api.example.com/v1/usage?unit=percent", "headers": { "x-client": "sample" } },
    { "id": "report", "method": "POST", "url": "https://api.example.com/v1/report", "body": "json" }
  ]
}]
```

```js
exports.service = async (panda) => {
  const first = await panda.connections.start({ connection: 'sample.usage/api', operation: 'usage', query: { window: '5h' } });
  let state = first;
  while (state.state === 'running') state = await panda.connections.poll({ connection: 'sample.usage/api', operation: 'usage', request: first.request });
  // state.response: { schemaVersion: 1, status: 200, body: <the parsed JSON answer> }
};
```

Types: `ConnectionDescriptor`, `ConnectionRequest`, `ConnectionJson` in `src/extensions/sdk/index.d.ts`. Fixture:
`tests/fixtures/extensions/runtime-connection-adapters/`.

## Declaration

| Field | Values |
| --- | --- |
| `authentication` | `bearer` (the credential is the bearer token), `header` (its value is sent as the header `headerName`), `query` (as the query parameter `queryName`), `none`. Any other value is `UnsupportedCapability` at run time. |
| `credential` | `{ "source": "host" }` (the default: entered in the host's dialog for this connection, the flow that existed before), `{ "source": "secret", "key": "<key>" }` (a package secret of R0802) or `{ "source": "held", "id": "<id>" }` (a credential PandaCode holds; its value is attached by R0805). |
| `adapter` | `json-summary` (unchanged: only `accepted` and `count`, 32 KiB) or `json` (the parsed answer in `response.body`, up to `maxResponseBytes`, default 256 KiB, at most 1 MiB). |
| `operations[].method` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. |
| `operations[].body` | `"json"`: `start` takes `body` (at most 256 KiB). Not for `GET`. |
| `operations[].headers` | Up to 16 fixed headers. A header the host owns (`host`, `content-length`, `authorization`, `content-type`, ...) or the credential's own header is `InvalidShape`. |
| `timeoutMs` | 100 to 30000. |

`start` takes `connection`, `operation`, optional `body`, optional `query` (up to 16 string pairs; the parameter the
credential uses is not one of them) and, only for a `host` source, the opaque `credential` handle read from `status`.
Any other field (an address, a header, a credential) is `InvalidShape`.

## Address rules

The address is the one the user saw at install: **https**, or **http on a numeric loopback address** (`127.0.0.0/8`,
`::1`), which is what a fake service of a test and a local daemon need. A query is part of the declared address. No user
information and no fragment. Redirects are never followed: the grant names the credential and the place it is sent
together, so following one would send the credential somewhere the user did not see. A redirect answers
`PermissionDenied`. The earlier rules that refused a query and any loopback address but `127.0.0.1` had no recorded
reason and are gone; the connection's address stays in the manifest (a settings-supplied address is not part of this
slice).

## Outcomes

| Outcome | When |
| --- | --- |
| `completed` with `response.body` | The answer is JSON within `maxResponseBytes`. `status` carries the HTTP status; a non-2xx status that carries JSON also completes, so the service can read the API's own error. An empty answer is `body: null`. |
| `InvalidShape` | The answer is not JSON (or `json-summary` lacks `accepted`/`count`); an unknown start field; a body for an operation that declares none; a handle that does not match the credential source. |
| `LimitExceeded` | An answer over `maxResponseBytes` (by `Content-Length` or while reading), a body over 256 KiB, more than 16 query pairs. |
| `Timeout` / `Cancelled` | `timeoutMs` elapsed / `cancel` was called. A late answer never replaces either. |
| `PermissionDenied` | The grant is gone (see below), a redirect, a request of another package, an operation that is not declared. |
| `UnsupportedCapability` | An authentication or adapter this build does not run, a method outside the five, a panel as caller. |
| `NotFound` | A credential PandaCode does not hold (a held id with no value yet, a host credential nobody entered). |
| `HostUnavailable` | The transport failed, or the `json-summary` adapter met an error status. |
| `Conflict` / `LimitExceeded` | More than 8 requests running, or 64 stored, for one package. |

No remote text, header or transport diagnostic ever crosses. A credential found anywhere in a JSON answer (a value or
a key) is replaced by `[redacted]`, so an echo service cannot hand it back.

## Grants

Service only on the duplex channel (a panel is `UnsupportedCapability`). `connections.request` is rechecked natively on
every call, including `poll` and `cancel`: revoke, narrowing to other projects, untrust, disable, safe mode and a stale
version answer `PermissionDenied` before anything is shown, and a request running when the grant goes away ends as
`PermissionDenied` with no output. A held credential also needs the `credentials.use` grant for that item. A package
holding the permission is never asked to confirm a request.

## What stays as it was

The activation flow (`connections` inside a command, with the credential entered in the host's dialog) keeps its
refusals, which are about identity and ownership rather than capability: the package cannot run `connect` or `revoke`
(the user enters the credential), a request or result belongs to the package and handle that started it, and an
address with user information, a fragment or plain `http` to a non-loopback host is not a place a credential may be
sent. That flow now runs through the same executor, so it also gains the new authentications, methods, body and query.

## Refusal reconciliation (Q031, Q033, Q053, Q054, Q123)

Changed: a query in a declared address and any numeric loopback host are accepted (they had no recorded reason); methods
beyond GET, the `json` adapter, header/query/none authentication, `body` and `query` are executed; a granted operation
is never refused for being a capability. Retained, each with a non-security reason: `connect`/`revoke` from a package
(identity: the user enters the credential in the host dialog), an extra `url` or `headers` field on `start`
(predictability: the contract has no such field, the declaration is the only address), `custom-signing`
(`UnsupportedCapability`: no such scheme exists, never a raw-key fallback), a redirect (`PermissionDenied`: the grant
names the credential and the place together, following would send it elsewhere), a foreign owner, a stale version and
an undeclared connection or operation (identity and ownership).

## How it is checked

- Native: `runtime_connection_adapters::tests` (a recording loopback API for method, headers, query and body of every
  authentication and method; invalid JSON, oversized by length and by stream, error status, redirect, timeout, cancel;
  the grant on every call and a request in flight at revoke; project narrowing; redaction of an echoed credential; the
  shared fake cloud B3 over real HTTP) and the rewritten `connections::tests`.
- Browser preview: `tests/extensions-runtime-connection-adapters.spec.ts` in Chromium and WebKit. The preview applies
  the same rules to a transport the test supplies, which calls real loopback servers (the recorder of the spec and B3).
- Real installed qualification of a service calling `panda.connections` is R0201's channel with this slice's
  dispatcher; it is not claimed here.
