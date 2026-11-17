# Usage, limits, accounts and metrics (runtime phase R2, slice R0204)

A background service reads four more host resources through `panda.context.query` and can ask the host to read the
usage windows again. All are answered natively over the duplex channel (see
[runtime-duplex-channel.md](runtime-duplex-channel.md)) and checked against the grants file on every call (see
[runtime-grants.md](runtime-grants.md)); nothing consults a webview consent. They are one-shot reads of `QueryResource`:
`ContextResource` is unchanged, so they cannot be subscribed to, and a package that wants to follow them reads again
after an event.

| Resource | Permission | Selector | Item |
|---|---|---|---|
| `usage` | `tasks.usage.read` (per project) | `taskId` | `taskId`, `turn`, `usedTokens`, `contextWindow?`, `reports`, `at` |
| `limits` | `harnesses.limits.read` | `harness?` | `harness`, `account`, `status`, `stale`, `windows: { id, label, usedPercent, resetsAt? }[]`, `readAt` |
| `accounts` | `harnesses.accounts.read` | `harness?` | `harness`, `id`, `active`, `signedIn`, `status`, `label?`, `plan?` |
| `metrics` | `metrics.read` | none | `app`, `services`, `unmeasured` (one item) |

## `usage`

- The host records every `usage` event of a run in the table `extension_turn_usage` (one row per task and turn). The
  turn is the number of user messages of the task at that moment, the numbering of the transcript. A later report of
  the same turn replaces the figures and raises `reports`, so each item is the LAST report of its turn. The rows are in
  the database file: they survive closing and reopening the app, and are removed with their task. The table is
  created on first use (no schema bump; a database also opened by the original build is unaffected).
- A provider event carries only the used tokens and the context window, so `input` and `output` do not exist, and
  `contextWindow` is absent when the provider did not report one. Nothing is filled with zero.
- The permission is checked for the project of the task on every call, registered as work and checked again before
  the result is returned, so revocation or narrowing during a read wins. Without the permission the answer is
  `PermissionDenied` before any lookup; an unknown task of a granted package is `NotFound`. `revision` changes with
  every report; a page continued with an older revision is `StaleContext`.

## `limits` and `accounts`

- Both serve the cache of the built-in usage view and never start a check. A harness nobody has read yet has no
  `limits` row; its `accounts` row says `status: "unchecked"` and `signedIn: null`.
- `limits` rows carry the windows of one reading (`account` is `default` for the harness's own setup or a saved
  connection id). A window `id` is made from its label and is unique inside the row. The e-mail, plan, message and
  dashboard address of a reading are not part of it.
- `accounts` has one row per account a harness can run with: its own setup (`id: "default"`, `active: true`) and each
  saved connection (`id` is the connection id, `label` its name, `active: false`: it is used by the tasks assigned to
  it; switching accounts is R0806). `signedIn` is `true` or `false` only when a reading proves it (`ready`,
  `signedOut`) and `null` otherwise. `label` and `plan` of the default row come from the reading.
- **No credential value** (ADR-0006). A connection is projected field by field (id, name, revision); its executable,
  arguments, environment, secret names and config folder are never read into a row.

## `panda.harnesses.refreshLimits({ harness? })`

- Needs `harnesses.limits.read`, checked natively; a missing grant is `PermissionDenied`. It resolves to `null`.
- It asks the usage view to read again, at most once per harness per 60 seconds across the whole app. A refusal
  inside the interval is `LimitExceeded` and does not move the window; exactly 60 s after the admitted refresh the
  next one is admitted. Without `harness`, the harnesses with a cached reading are refreshed (those inside their
  interval are skipped; all of them refused is `LimitExceeded`). An unknown harness is `NotFound`; a request field
  beyond `harness` is `InvalidArguments`.
- Revocation or narrowing while the readings are taken wins over the call (`PermissionDenied`).

## `metrics`

- `app` holds what the host measures at the call: `coreRssBytes` (resident memory of the core process),
  `activeAgents`, `activeTerminals`, `databaseBytes` (database plus WAL). A figure the platform cannot measure is
  absent, never `0`. `services` lists each running service (`package`) with its measured resident memory `rssBytes`
  when a sample exists.
- Per-task figures (`tasks`, with `rssBytes` and `cpuPercent`) need a collector that does not exist yet, so `tasks` is
  absent and `unmeasured` names it (`tasks`, `app.<field>`, `services.<id>`). Nothing is invented.

## Pages and limits

At most 50 items and 256 KiB per page (`LimitExceeded` over 50; `nextCursor` continues where a cut page stopped); a
continued page whose data changed is `StaleContext`. Every limit is for stability and predictability, none is a trust
restriction (ADR-0005).

## Where it runs

- `runtime_usage_resources.rs`: `serve` (`usageQuery`, `limitsRefresh`), `query` (pure over a store, the grants and a
  `Facts` source), `record` (the ledger), `Throttle`, and the row builders. Declared through `#[path]` inside
  `runtime_service_lifetime.rs`. `agent_usage.rs` gains the read-only `peek` / `peek_connection`; the `usage` arm of
  `save_agent_activity` in `lib.rs` calls `record`.
- `node-host.cjs` service mode: the routing of the four resources and `panda.harnesses.refreshLimits`.
- Preview: `src/extensions/runtime-usage-resources.ts` mirrors the rules (labelled synthetic);
  `tests/extensions-runtime-usage-resources.spec.ts` runs it in both engines. Fixture service:
  `tests/fixtures/extensions/runtime-usage-resources/`.

## Retained refusals (non-security reasons)

- Q015 / Q107 (status components): the usage actions of the status recipe (`usage-poll`, `usage-sign-in`,
  `usage-dashboard`, `usage-refresh`, toasts, update-restart) and the `email`, `plan`, `message`, `dashboardUrl` fields
  of the webview status component stay refused: they belong to the host-owned usage panel and its short-activation
  recipe (R0207), not to the service reads of this slice. A package reads the same figures through the resources
  above under their named permissions; the refresh needs the user's Continue only in the webview recipe.
- Q056 (`extensions-inventory.test.mjs`): `query('processes')` stays `UnsupportedCapability` (no such resource exists);
  the inventory DTOs of the webview broker keep their exact shape, and the accounts of this slice are a separate
  native resource.
- Q081 (`extensions-status.test.mjs`): the webview status component's cached-only reads stay as they are (the cache
  is the host's, no read or network request from the component); the service resources serve the same cache.
- Foreign owner, stale version, ungranted project, an extra request field, a harness or task selector a resource does
  not take, and a page continued after a change stay refused for predictability and stability.
