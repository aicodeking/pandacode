# Package settings and content resources (runtime phase R2, slice R0203)

A background service reads two kinds of host data without a webview: the values of its own settings pages
(`panda.settings.get`) and the content of tasks (`panda.context.query` for `tasks`, `transcript`, `tools` and
`changes`). Both are answered natively over the duplex channel (see [runtime-duplex-channel.md](runtime-duplex-channel.md))
and are checked against the grants file on every call (see [runtime-grants.md](runtime-grants.md)); nothing here
consults a webview consent.

## `panda.settings.get({ page })`

```ts
panda.settings.get(options: { page: string }): Promise<{ readonly schemaVersion: 1; readonly revision: number; readonly values: Readonly<Record<string, Json>> }>;
```

- The package's OWN page only (`contributes.settings[].id`). It needs no permission beyond the `ui.contribute` that
  declares the page: it is the package's own data. The package identity comes from the connection, never the request;
  a request with any field beyond `page` is `InvalidArguments`.
- Another package's page, an unknown page, a disabled package and safe mode answer `NotFound`.
- `values` are the stored values, or the declared defaults of each field (`value`, else `""` / `false` / `[]`) when
  nothing was saved.
- `revision` is FNV-1a 64 of the values as compact JSON with sorted keys, kept to 53 bits (an exact JavaScript number).
  It changes exactly when the values change and is the same after a restart. The native function is
  `settings_revision`; `settingsRevision` in `src/extensions/runtime-content-resources.ts` gives the same numbers.
- **`settings.changed`.** When the user saves a page (`extensions_settings_set`), the host reports
  `{ kind: "settings.changed", page, revision }` to that package's service only (workspace events, R0202; the service
  needs `events.workspace`). The notice carries no values: the service reads again and compares revisions.

## Resources of `panda.context.query`

`ContextResource` stays the five subscribable resources. The four below are one-shot reads of `QueryResource`; the
change notices for them come from `events.workspace` and the hooks.

| Resource | Permission | Selector | Item |
|---|---|---|---|
| `tasks` | `tasks.summary` | none | `id`, `projectId`, `status`, `title`, `harness`, `model`, `mode`, `stage`, `startedBy` |
| `transcript` | `tasks.transcript.read` | `taskId` | `id`, `turn`, `role`, `text`, `at`, `attachments?` (`id`, `kind`, `name`, `bytes`; metadata only) |
| `tools` | `tasks.tools.read` | `taskId` | `callId`, `turn`, `tool: { kind, name }`, `status`, `input`, `output`, `inputComplete`, `outputComplete`, `writePaths?` |
| `changes` | `tasks.tools.read` | `taskId` | `turn`, `path`, `patch` |

- **Grants.** The permission is checked natively for the project of the task on every call (a task of a project
  outside the grant is `PermissionDenied`), registered as privileged work, and checked once more before the result is
  returned: revoking or narrowing while a read runs wins over its result. A package that holds none of the permission
  gets `PermissionDenied` before any lookup, so an unknown task answers the same as a known one. An unknown task of a
  granted package is `NotFound`. The version of the installed package must match the grant (`PermissionDenied`).
- **`tasks`** lists the tasks of every project the grant reaches (drafts excluded), ordered by id. `startedBy` is
  `"user"` for now: nothing in the store records another starter (the same limit as the `task.created` event).
- **`transcript`** is the conversation: `user`, `assistant` and `system` rows as they are; error, handoff and
  coordination rows are `note`. Tool rows and the turn-change marker are not transcript. `turn` counts the user
  messages up to the row. Package-added text (`addedBy`) does not exist yet.
- **`tools`** serves what the store holds, which is the display preview of the call: `inputComplete` and
  `outputComplete` are always `false`. `tool.kind` is derived from the stored name (`shell`, `edit`, `read`, `search`,
  `web`, `mcp`, `other`). `decidedBy` appears with the hooks slice.
- **`changes`** are the stored patch bodies of each turn, one item per changed file.
- **Pages.** At most 50 items and 256 KiB per page (`LimitExceeded` for a `limit` over 50); when the 256 KiB cuts a
  page short, `nextCursor` continues where it stopped. One text field is cut at 64 KiB on a character boundary and the
  item carries `truncated: true`. `revision` identifies the data the page was read from; a page continued with an
  older `revision`, or data that changed while it was read, answers `StaleContext`.
- `usage`, `limits`, `accounts` and `metrics` are R0204. A resource outside `QueryResource` is `UnsupportedCapability`.
- Attachment contents (`panda.tasks.attachments.read`) are not part of this slice: only their metadata is served.

## Where it runs

- `runtime_content_resources.rs`: `serve` (the two requests, called by the app dispatch of the service lifetime),
  `query` (pure over a `Store` and the grants), `settings_reply` / `settings_revision`, and the producer
  `settings_changed`. Declared through `#[path]` inside `runtime_service_lifetime.rs`.
- `node-host.cjs` service mode: `panda.settings.get` and the routing of the four resources to the native read; the
  other resources of `panda.context.query` keep their short-activation path.
- Preview: `src/extensions/runtime-content-resources.ts` mirrors the rules (labelled synthetic);
  `tests/extensions-runtime-content-resources.spec.ts` runs it in both engines.

## Retained refusals (non-security reasons)

- Q041: `ContextResource` is exactly the five subscribable resources (stable subscribe contract).
- Q028/Q055/Q124: the webview broker (`context.rs`) keeps its three-field task row and its webview consents; the
  extended row is the service's native read, which uses native grants. Those consents are the short-activation
  surface's own state.
- Foreign owner, stale version, ungranted project, an extra request field and a page continued after a change stay
  refused: they protect predictability and stability of the contract, not trust in the package.
