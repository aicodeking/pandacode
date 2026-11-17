# Workspace settings (`workspace.settings`)

Runtime phase R4, slice R0407. A trusted background service reads and changes the app's own workspace settings:

```js
const keys = await panda.workspace.settings.list();                 // ['sidebar.sort', ..., 'bot:<id>', ...]
const { key, value, revision } = await panda.workspace.settings.get('sidebar.scope');
await panda.workspace.settings.set('sidebar.scope', 10, { revision }); // StaleContext when it changed meanwhile
```

The permission `workspace.settings` is global (not project scoped), listed at install, granted with the trust decision,
checked against the grants file on every call and once more right before a write (a revoke or a package that was
disabled in between changes nothing), and revocable by the user. A package that holds it is never asked again per action
(ADR-0005). Pairing, remote access and the user's own recovery switches are not reachable through it (below).

## The frozen keys

| Key | Value | Lives in |
|---|---|---|
| `sidebar.sort` | `{ tasks: manual \| recent \| created, projects: recent \| added \| name \| manual, group: project \| flat }` (all three) | `pandacode.sidebar.sort` |
| `sidebar.scope` | tasks shown per section: `3`, `6`, `10` or `15` | `pandacode.sidebar.sort` (`perProject`) |
| `sidebar.filter` | project id, or `""` for all (at most 128 characters) | `pandacode.projectFilter` |
| `sidebar.order` | project ids in the dragged folder order (unique, at most 512) | `pandacode.sidebar.projectOrder` |
| `view.open` | `conversation`, `board` or `github` | `pandacode.view` |
| `tiles.layout` | task ids tiled side by side (unique, at most 6; fewer than two means no tiling) | `pandacode.tiles` |
| `find.query`, `projects.search` | text (at most 512 characters, no control characters) | the window (live, not persisted) |
| `tokenSaver` | `{ defaults?, threads? }` | `pandacode.tokenSaver` |
| `council` | `{ target?: 7..10 as offered, maxRounds?: 3 \| 5 \| 10 \| 25, reviewers?: 0 \| 2 \| 3 \| 4 \| 5, newThreads?: boolean }` | `pandacode.council` |
| `bot:<id>`, `channel:<id>` | `{ pinned?: boolean, order?: integer \| null }` | `pandacode.botsPinned`, `pandacode.botsOrder` |
| `team.profiles`, `widgets`, `machines.orchestration` | a JSON object (their own surfaces own the shape) | the settled store |
| `appearance.compact` | boolean | `pandacode.compact` |
| `appearance.theme` | `light` or `dark` | `pandacode.theme` |

A `bot:<id>` or `channel:<id>` key exists once the window has published that bot or channel; the key of a bot that is not
there (or was deleted) is `NotFound`.

## What is not a key

`telemetry`, the routing opt-in, the GitHub switch, safe mode, updates, extension trust, pairing, remote access and held
credentials are not settings keys. They answer `NotFound` like any unknown name; there is no call, flag or alias that
reaches them. Reasons (none of them a limit on a trusted package's power over the app's own layout and preferences):
the telemetry opt-outs, the routing opt-in and the GitHub switch are rules of the original project (no telemetry, no
traffic before opt-in); safe mode, updates and extension trust are recovery; pairing a machine and granting remote
access stay with the user, because trust in a package's author is not trust in another machine; a held credential is
never handed to a package (ADR-0006). So a package change never bypasses the original project's rules: those switches
are simply not settings.

## Failure behaviour

| Condition | Answer |
|---|---|
| No grant, revoked, narrowed away, package disabled, safe mode | `PermissionDenied` (path `workspace.settings`) |
| Unknown or excluded key; `bot:`/`channel:` id the window has not published | `NotFound` (path: the key) |
| `revision` given and not the key's current one | `StaleContext`; nothing changes |
| A value the key does not take; an option the call does not take | `InvalidShape` |
| A value over 64 KiB, nested deeper than 8, a list or text over its bound | `LimitExceeded` |

Revisions start at 0 for a fixed key nobody has written, then count every change (`get` answers `value: null` at 0).
A write of the value already held changes nothing and reports nothing. Without a `revision` the write is unconditional.

## Where each part runs

- **Native** (`src-tauri/src/extensions/runtime_workspace_settings.rs`): the frozen key set and value rules, revisions,
  the permission check (twice), a file-backed store (`workspace-settings.json` next to the grants, independent of
  SQLite), and propagation. Request `workspaceSettings` (`op: list | get | set`) of `node-host.cjs`, served in
  `runtime_service_lifetime.rs`.
- **Window** (`src/extensions/runtime-workspace-settings.ts`, started by `main.ts`): it owns the live state. It
  publishes what its own storage holds (`extensions_workspace_settings_publish`), applies a package's change to that
  storage and tells the surface (`pandacode-workspace-setting` on `window`, detail `{ key, value, revision, by }`, where
  `by` is the package that made the change), then acknowledges it (`extensions_workspace_settings_ack`). A package's
  change that is not applied yet is never overwritten by the window's older value.
- **Propagation**: every change emits `extensions-workspace-setting` to the window and the workspace event
  `settings.changed` with page `workspace.<key>` and the store's revision to services subscribed to it (the service that
  made the change hears it too: read again, compare the revision).

Preview twin: `previewWorkspaceSettings` (same rules and refusal envelope, labelled stand-in; the window half is the
real one). It proves protocol and rules; it never qualifies a service process or a native grants file.

## Package-owned Settings pages

A package's own Settings page and its persisted values are separate and already complete: `extensions_settings_get` and
`extensions_settings_set` store the values and `panda.settings.get` (R0203) reads them for the service (S0609 handed the
page's own values to this slice; nothing more is needed here). `workspace.settings` is only the app's keys above.

## Refusal-test reconciliation

Owner rows: Q003, Q005, Q006, Q009, Q012, Q014, Q016, Q069, Q071, Q072, Q075, Q078, Q080, Q082, Q093, Q096, Q098, Q099,
Q102, Q106, Q108. They are mixed rows, split by operation among their listed owners.

What this slice delivers is the **service call**: a service that holds `workspace.settings` now changes the sort, filter,
scope and order of the sidebar, the open view, the tile layout, the find and project search text, the token saver, the
council defaults, bot and channel pins and order, team profiles, widgets, machine orchestration, compactness and theme.
The permissioned assertions that change are therefore the ones that said "a package cannot change these": they are
carried by `tests/extensions-runtime-workspace-settings.spec.ts` (round trip of every key; refusals) and by
`runtime_workspace_settings::tests`.

| Rows | Surface | Changed by this slice | Retained refusal and its non-security reason |
|---|---|---|---|
| Q009, Q075, Q102 | window menus (view, sort, scope, filter) | the data operations (`view.open`, `sidebar.sort`, `sidebar.scope`, `sidebar.filter`) are now a granted service call | A declarative menu contribution still cannot carry a write or pick for the user: the host menu is a fresh user choice (predictability); the six controls stay refused as contribution actions |
| Q012, Q078 | sidebar | `sidebar.order`, `sidebar.sort`, `sidebar.filter` are settable | `delete`, `rename`, `reorder`, `remove-project`, `pin`, `drag` stay refused as contribution actions: they are the user's gestures on rows, and project removal is `workspace.manage` (irreversible, host confirmation) |
| Q006, Q072, Q099 | tiles | `tiles.layout` is settable | tile and picker controls stay refused as contribution actions; the draft moves only after a fresh user choice (predictability) |
| Q003, Q069, Q096 | composer panels | `tokenSaver` and `council` are settable | queue, steer and send controls stay refused here: they are `tasks.message` / `tasks.control` (R0402, R0404B) |
| Q005, Q071, Q098 | thread extras (R0203 took the reads) | find text (`find.query`) is settable | attachment, turn and usage-limit actions stay refused here: they belong to R0404B |
| Q014, Q080, Q106 | roster | `team.profiles` and `widgets` are settable | `stop`, `stop-subagent`, `approve`, `answer`, `profile-delete`, `profile-rename`, `widget-pin` stay refused as contribution actions: task control and hooks own them (R0404, R0404B, R0505, R0507) |
| Q016, Q082, Q108 | settings | the app keys above are settable; package pages stay as they were | `turn-checks`, `provider-credentials`, `remote-pairing`, `github-sign-in`, `safe-mode`, `app-update` and `project-remove` stay refused and are not keys: rules of the original project, recovery, and the user's pairing and credentials (see "What is not a key") |
| Q093 | content panels | none (terminals, guests, search, documents belong to R0409/R0410/R0901) | unchanged |

No assertion of an old test file was edited by this slice: those rows assert that **contribution actions** are refused, a
contract this slice leaves as it was (a settings write is a service call, not a declarative control), so every old
refusal still holds. The changed permissioned assertion is the new one: a service with the grant succeeds, one without it
(or revoked, or in safe mode) is `PermissionDenied`. The hub owners of `contracts.rs` and the `extensions-*` unit tests
keep the old rows green; any row whose wording needs the new permissioned counterpart is updated in the final test phase.

## Evidence columns

Preview/model: `tests/extensions-runtime-workspace-settings.spec.ts` (ports 16271 Chromium, 16272 WebKit). Native unit
tests: `runtime_workspace_settings::tests`. An installed service driving `sample.runtime-workspace-settings` against
the real window and grants file: the final test phase and R1212 qualification.
