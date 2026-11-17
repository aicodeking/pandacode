# Held credentials used without being read, and account switching (`credentials.use`)

Runtime slice R0805. Native owner: `src-tauri/src/extensions/runtime_held_credentials.rs`; browser preview:
`src/extensions/runtime-held-credentials.ts`. ADR-0006 governs: the value of a credential PandaCode holds is never
handed to a package, a panel or the webview. There is **no `credentials.read`**.

## What a package can do

- **Use** a held credential: declare a connection with `credential: { "source": "held", "id": "<item>" }` (see
  `runtime-connection-adapters.md`) and ask for it with `panda.connections.*`. The host attaches the credential from its own
  store as a bearer token, a header or a query value, runs the request and returns only the adapter's answer. A credential
  found in a JSON answer is replaced by `[redacted]`.
- **Switch accounts**: `panda.harnesses.switchAccount({ harness, account })` makes `account` (an `id` of the `accounts`
  resource: `default`, or a saved connection of the harness) the active account. Resolves to `null`.

Both need `credentials.use`, granted per item. Items: `provider:<harness>` (keys PandaCode stores for glm, mimo, alibaba,
deepseek, commandcode), `connection:<id>` (the first secret variable of a saved connection), `bot:<id>` (the channel token),
`cloud:<name>` (`<name>_key` or `<name>_token` of the cloud settings), `deploy:<name>`, `speech`, `github`. Items whose store
holds nothing the host can attach (`deploy:*`, `speech`, `github`, unknown providers) answer `NotFound` on use.

## Rules

- Every use is rechecked natively against the item (`RuntimeGrants::begin`). Revoke, narrowing that drops the item, untrust,
  disable, stale version and safe mode answer `PermissionDenied`; a request in flight then ends as `PermissionDenied` with no
  output. A use of another item is `PermissionDenied` and writes nothing.
- **Activity list.** Each use appends `{at, kind: "credential.use", item, address, package, version}` to the package's list
  (`<app data>/extension-held-credentials-v1/activity.json`, newest 100 per package). `address` is scheme, host, port and path;
  the query is not kept. The entry is written before the value leaves the store; if it cannot be written the use does not
  happen (`HostUnavailable`). A switch appends `{kind: "account.switch", item}`. There is no field for a value. The webview
  reads the list through `extensions_credential_activity` (main window only).
- **Switching** needs `credentials.use` for the account's item (`provider:<harness>` for `default`, otherwise
  `connection:<id>`). The choice is file-backed (`active.json` beside the list, independent of SQLite). The `accounts`
  resource (R0204 contract) shows the new `active` flags, so its revision changes with a switch; a task without an assignment of
  its own launches with the active account (`connections::for_task`). No credential is returned, written or replaced.
- Service only on the duplex channel; a panel is `UnsupportedCapability`. Package, version and manifest come from the
  connection's identity, never from the request. The legacy activation-time `connections.rs` start uses the same grant,
  store and record.

## Schemes and limits

Bearer, header and query authentication (the schemes the examples use) are covered with a held source. Unknown schemes and a
streamed answer with a held credential are **not** implemented: decision 4 follow-ups, recorded only if a parity case needs
them. Account switching does not move a running task: warm agents keep their account, and the next launch of a task with no
assignment uses the active one. HTTP tool-server header attachment and the stdio negative case belong to R0703.

## Refusal dispositions (ADR-0005; Q031, Q032, Q053, Q123)

Changed: a held source is now resolved (it answered `NotFound` before), `switchAccount` exists, `accounts[].active` follows
switching. Retained, non-security reasons: another item, revoked, stale version and foreign owner (ownership and
predictability); panel callers (a secret never reaches a webview); unknown fields in a request (predictability); `credentials.read`
and any value export (ADR-0006); unknown schemes and streaming (no such adapter; decision 4).

## Tests

Written, not run (deferred to the final test phase): `runtime_held_credentials::tests`, held tests in
`runtime_connection_adapters::tests`, `tests/extensions-runtime-held-credentials.spec.ts` (ports 15991/15992), fixture
`tests/fixtures/extensions/runtime-held-credentials/`.
