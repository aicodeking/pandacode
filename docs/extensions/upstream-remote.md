# Upstream remote methods and the phone (S0610)

Sync phase P6. After the 0.3.128 merge PandaCode Connect gained fifteen remote method modules
(`src-tauri/src/remote/methods/*.rs`, 119 methods) and a phone app at desktop parity (`mobile/`). This page records how
they sit beside the extension platform. It adds no contract, permission or surface: the methods are native only and have
no renderer.

## What the methods are

- A paired device calls a method through the host (`remote::host`); the **device grant** (`view`, `control`, `full`,
  `remote/grants.rs`) decides whether the call runs. Each method declares its narrowest grant in `Method.access`; the
  registry (`methods/mod.rs`) feeds the hosting-off refusal, the grant check, the request lanes, `batch` and replay, so
  one declaration covers all of them.
- **No method reads a package, a package grant or a manifest.** Package grants live in the file-backed runtime store
  (`runtime_grants.rs`) and carry authority only for package code running on the desktop. A phone call therefore
  neither gains nor loses a package grant, and no package action is forged through a method. Where a method starts work
  for a package provider (`github.startTask`, `chat.start`, `team.start`) it is bound to what the package captured, as
  `task.start` is (the same `UnsupportedCapability`/`MissingProvider` answers as `tests/extensions-remote.spec.ts`).
- The phone never runs extension code. `extensions.capabilities` (opt-in negotiation, unchanged) reports placements; a
  surface that needs the desktop is reported unsupported placement and the phone keeps core and history.
  No mobile extension adapter exists or is added.

### Inventory (derived from the Rust registry; `tests/upstream-remote-extensions.spec.ts` recomputes it)

| Module | Methods | View | Control | Full |
| --- | --- | --- | --- | --- |
| `admin` | 17 | 7 | 1 | 9 |
| `composer` | 12 | 4 | 8 | 0 |
| `design` | 6 | 4 | 2 | 0 |
| `files` | 7 | 6 | 0 | 1 |
| `git` | 14 | 5 | 2 | 7 |
| `github` | 9 | 6 | 0 | 3 |
| `projects` | 4 | 1 | 0 | 3 |
| `rewind` | 2 | 1 | 1 | 0 |
| `schedules` | 8 | 2 | 3 | 3 |
| `search` | 1 | 1 | 0 | 0 |
| `settings` | 8 | 6 | 0 | 2 |
| `team` | 2 | 1 | 0 | 1 |
| `terminal` | 6 | 0 | 0 | 6 |
| `threads` | 9 | 2 | 6 | 1 |
| `tools` | 14 | 8 | 2 | 4 |

The nearest package permissions are `tasks.start`, `tasks.message`, `tasks.control` and `connections.summary`
(the last returns a bounded computer name only). They are separate authorities from a device grant: holding one never
lets a device call a method, and a device grant never lets a package act.

## Evidence

| Claim | Evidence | Column |
| --- | --- | --- |
| Inventory and grants match the registry; no method names a package | `tests/upstream-remote-extensions.spec.ts` ("registry") reads the Rust sources | static |
| Installed fixture `sample.upstream-remote`: grant, attributed state, revoke, revoke all | same spec ("package grants") over `tests/fixtures/extensions/upstream-remote/manifest.json` | preview (synthetic stand-in of the native store) |
| Disable and uninstall suspend then remove the grants; safe mode lists no package | same spec ("lifecycle") | preview |
| Stale captured host or unsupported peer starts nothing | same spec ("stale") over `tests/fixtures/extensions/remote-peers.json`; `tests/extensions-remote.spec.ts` | preview |
| Phone-facing protocol unchanged by packages | same spec ("phone") checks `tests/fixtures/extensions/mobile-projection.json`, the absence of a mobile extension adapter and the existing mobile checks `mobile/tests/extensions-projection.test.ts`, `capabilities.test.ts` | static; the mobile checks themselves run in the final test phase |
| Native authority (grant check, bound starts, replay) | `remote::host` and `remote::methods::*` unit tests, `remote::grants` tests | native |
| Installed WebView and a real second machine | not claimed here; R0108 (executor placement) and the R12 qualification own them | pending |

Browser preview never substitutes for installed acceptance: the grant store in the browser is a labelled synthetic
stand-in. Tests are written, not run, at this point (deferred to the final test phase).

## Hide, reorder, restore, keyboard and focus

The methods have no UI, so there is nothing to hide, reorder or restore and no focus order to keep. The surfaces that
choose a computer (Run on menu, link cards, lineage) are covered by `panda.machines`
(`docs/extensions/machines.md`, `tests/extensions-machine-coverage.spec.ts`), which already proves hide, reorder,
restore, keyboard, disable and safe mode for them.

## Retained refusals (Q037)

| Row | Retained refusal | Reason it stays (not security) |
| --- | --- | --- |
| Q037 `projections.rs` `bot_web_projection_never_forwards_package_actions_contributions_or_desktop_html` | The web/phone bot projection stays `withheld` with its stable reason | Contract shape and fault isolation: the phone cannot execute package code or desktop HTML, so forwarding them would only break the page. Nothing is added here that makes the row permissioned, so it stays as it is. |
| Stale or foreign host in `remote_start_task` | `UnsupportedCapability` / `MissingProvider`, nothing started | Predictability and irreversibility: a start must run on the host and provider the user captured; it never retargets. |
| Another package's or an undeclared grant name | `PermissionDenied` | Predictability: one package cannot receive another's grant; the vocabulary stays closed. |

No retained refusal restricts a trusted package that holds the matching permission.

## Handoffs (new runtime abilities, never permanent refusals)

| Ability | Owner |
| --- | --- |
| A package running on the executing machine for a remote or headless task (placement, cross-machine proof) | R0108 |
| A package starting or controlling a task on another machine from package code | R0401, R0404 |
| Installed WebView and real two-machine qualification | R1212 via the S07C handoff rows |

## Boundaries

No telemetry, accounts or automatic request is added. Pairing and granting remote access stay with the user. With no
package installed, disabled or in safe mode, every method behaves as the original at 0.3.128.
