# Examples: an API-backed provider and team tools as author packages

Task S07B. Two installable packages, both offline: no live inference, no personal credential, no account.

| Package | Directory | Shows |
|---|---|---|
| `sample.upstream-api` | `examples/extensions/upstream-api/` | A provider that talks to an HTTP API through a declared connection, with a package-private fake key |
| `sample.upstream-team-tools` | `examples/extensions/upstream-team-tools/` | A package tool delivered, attributed to the package, to a team-capable role |

Both join the installable author examples (`tests/fixtures/extensions/examples-v1.json`, categories `api`, `service`, `tool`,
`harness`) and are checked by `tests/extensions-examples.test.mjs`. The spec `tests/upstream-api-tools-example.spec.ts`
(ports 16121 Chromium, 16122 WebKit) exercises them against a fake loopback service. Written, not run (deferred to the final
test phase).

## The API provider

- Manifest: permissions `ui.contribute`, `runtime.service`, `connections.request`, `secrets.private`; one command
  (**Store the fake API key**), one connection `sample.upstream-api/chat` (header authentication `x-api-key`, credential
  `{ "source": "secret", "key": "api-key" }`, adapter `json`, operations `complete` POST and `models` GET) and one provider
  with `fixture-small` in Standard mode.
- Credential: the package stores the fake canary `tok-fake-upstream-api-key` in its own secrets. The host attaches it to the
  request ([connection adapters](../runtime-connection-adapters.md), [private secrets](../runtime-private-secrets.md)); the
  package never builds a header and never receives it back, and an echoed key is `[redacted]` in the answer. A held credential
  (`credential.source: "held"`, `credentials.use`, [held credentials](../runtime-held-credentials.md)) is the same shape with
  one more grant; this example does not use one because that would send a real held key to the fake service.
- Flow: the service owns `panda.connections`; the provider handler turns the JSON answer into `session`, `text` and `usage`
  events, so the existing composer, trace and model picker show it like any provider.
- The manifest address `http://127.0.0.1:9` is a placeholder; the spec rewrites it. Only `https` or a numeric loopback
  `http` address is accepted.

## The team tools

- Manifest: permissions `ui.contribute`, `tools.execute`; one manifest tool `sample.upstream-team-tools/lookup` (literal
  arguments, no shell) and the team-capable provider `sample.upstream-team-tools/team` (`metadata.teams: true`).
- Delivery: a role that received the lead's catalog (`run.teamTools`) runs the tool and emits `tool` rows named
  `sample.upstream-team-tools/lookup`, so the trace row carries the package id. A role without the catalog is not eligible and
  says so. A host tool outside the bridge (`pandacode_open_browser`) stays `UnsupportedCapability`.

## Grant, revoke, failures

| Situation | Result |
|---|---|
| Permission not granted at install | `connections.request`, `secrets.private`, `runtime.service` or `tools.execute` answer `PermissionDenied`; nothing is sent |
| Revoke `connections.request` | the next call and any request in flight end `PermissionDenied`, nothing reaches the fake API |
| Key not stored (setup not run) | `NotFound`; the fake API is never reached |
| Wrong key | the API's own `401` completes with its error JSON; the provider fails instead of printing it |
| Service stopped or package disabled | `HostUnavailable` (the provider has no bridge); disabled packages leave the picker and the built-in providers remain |
| Slow or oversized answer, redirect | `Timeout`, `LimitExceeded`, `PermissionDenied` per the adapter table |
| Unknown tool entry | the manifest tool fails with `NotFound`; the row is `failed` |

## Runtime prerequisites

Executable trust accepted for this content; the package enabled and its service started (`runtime.service` is
`onEnable`); the grants above approved; for the preview, the `?private-secrets&connection-adapters` and
`?extension-harness` harness pages. Windows x64 is the qualified native target; other platforms are `UnsupportedRuntime`
until their evidence exists.

## Gaps (recorded once, for S07C; none is a security refusal, ADR-0005 and ADR-0006 apply)

| Gap | Need the author cannot express | Minimal reproducer | Owner |
|---|---|---|---|
| A1 | Real token streaming: the `json` adapter returns the whole answer, so the provider replays the service's chunk list | Fake API sends SSE: `InvalidShape` (not JSON). A streamed answer, with or without a held credential, is not implemented | R8 credentials and connection streaming (R0804/R0805 follow-up) |
| A2 | The provider handler has no `panda`: it cannot call `connections` itself and relies on a service sharing module state in one host process | Provider with no running service: `HostUnavailable` from the package | R7 model tools / R0801 (a `core.connections` seam or documented process sharing) |
| A3 | `ServicePandaCode` in `sdk/index.d.ts` does not type `connections`, so a TypeScript author gets no types for the service calls used here (the packages are plain `.cjs`) | `panda.connections` in a `.cts` service fails type-check | SDK owner of R0804 (short edit of the shared SDK hub) |
| A4 | Rows and cards attributed to a package's model tools or tool servers, delivered to the built-in harnesses' team agents | Only this package's own provider receives the tool; Claude/Codex team workers never see `sample.upstream-team-tools/lookup` | R7 (`tools.model`: model tools and tool servers) |
| A5 | Offering package tools to ZCode through the per-session MCP bridge (`architect.rs`) | No contract names it; a new trust decision is an open point for the user | R7, user decision |
| A6 | Alibaba Token Plan expressed as a package (a Claude Code launch with a private endpoint and key) | Declared ACP launch has a fixed `env`; a held or private key may not enter the environment (ADR-0006), no endpoint override seam | R8 credentials (R0805 host header or stdio-safe attachment), R12 parity examples |
| A7 | Parity and reference packaging of both examples as qualified references | Qualification is preview and Node-stand-in only; no installed or live evidence | R12 parity/examples (R1212) |

## How it is checked

`tests/upstream-api-tools-example.spec.ts`: the shipped `main.cjs` run in Node with a stand-in for the host (event order,
failures, attribution, no credential in any event); the preview install flow in the model picker with enable and disable;
the preview's connection executor against the same fake service (canary attached by the host, redaction, wrong key, revoke).
The native transport, grants and redaction belong to `runtime_connection_adapters::tests`. Not run when written.
