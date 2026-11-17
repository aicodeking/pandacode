# Application menu, settings and usage after the upstream merge

Sync slice S0609 (P6). PandaCode 0.3.128 added a usage fix link, a Settings reveal helper, crash-restart settings
text and a macOS Quit item swap. This page records how each is covered by an extension contract or a named
exception, and what evidence closes it. With no extension installed, all disabled, or in safe mode, Settings, the
Agent usage panel and the application menu behave exactly as upstream 0.3.128.

## Members

| Member | Source | Coverage |
|---|---|---|
| Settings sections and pages | `src/settings-sections.ts` | Adapter: `panda.settings` (sections order and reversible hide, page actions, section context menu). Pinned sections stay (see [settings.md](settings.md)). |
| Settings reveal | `src/settings-reveal.ts` | Adapter helper `revealTarget`: a package names a core page and, optionally, one known reveal id; the host reveals the original node. A credential field or a selector is refused. |
| Usage fix link | `src/usage-labels.ts` | Named exception: an inline link whose only effect is `revealSetting('providers')`, already a settings-pages member. Visibility is carried by the status coverage. |
| Usage roster | `src/agent-usage.ts` | Adapter: `panda.status` (details-first recipe, captured tab, period, agent row and Refresh; see [status.md](status.md)) plus the roster presentation in `src/extensions/upstream-menu-usage.ts`. |
| Application menu Quit | `src-tauri/src/app_menu.rs` | Named exception, macOS only: swaps Tauri's default Quit item for `pandacode-app-quit` (`CmdOrCtrl+Q`) so quitting goes through the exit path. No new menu item, nothing for a package to extend. |

## Usage presentation consumes R0204

The adapter owns no usage store. Its rows are derived from the read model of R0204 (`runtime-usage-resources.ts`,
mirroring `runtime_usage_resources.rs`): `limits` and `accounts` rows from the cached readings, the per-turn ledger
in `extension_turn_usage` for `usage`. A figure that is not measured is absent, never zero; the e-mail, plan,
message and dashboard address of a reading and a connection's environment, secrets and folders never reach a row
(ADR-0006). The roster follows `HARNESSES` (Alibaba is part of it); the count is never fixed in the adapter.

Finding for S04B: the Agent usage roster shows 22 provider calls where the older baseline expected 21. The extra
one is the provider Alibaba added upstream (Token Plan); it is a built-in, not a package provider.

## Captured actions

A presentation captures a context id and the revision of its rows (`listRevision`, the same hash R0204 serves). An
action carries exactly `context`, `revision`, `row`, `requestId`:

| Case | Answer |
|---|---|
| a new reading, a switched account or a refresh since capture | `StaleContext` |
| another context, a hidden row or an unknown row | `StaleContext` |
| the same `requestId` again | `AlreadyApplied` |
| an extra field, an empty or over-long id | `InvalidArguments` |
| the grant revoked or narrowed, or another owner | `PermissionDenied` |
| the package disabled, uninstalled or in safe mode | `Revoked` |

## Layout

Rows can be hidden, reordered and restored. `overview` and `refresh` are pinned: the sign-in notice and Refresh stay
reachable (stability, not distrust). A state naming an unknown or pinned row changes nothing; safe mode and disabling
return the built-in order at once while the open page, its focus and unsaved edits stay.

## Fault fallback

`withFallback` runs a package presentation; a throw reports once ("Built-in rows remain active") and the built-in
rows stay. Nothing blocks Settings or the usage panel.

## Fixture and evidence

- Fixture: `tests/fixtures/extensions/upstream-menu-usage/manifest.json` (settings and status recipes, section and
  usage-control layouts, commands, a settings-page action and a usage context action).
- Spec: `tests/upstream-menu-usage-extensions.spec.ts`, registered in both Playwright configurations and in CI
  (ports 16091 and 16092). Columns are kept apart: the deterministic model and the browser preview run in the spec;
  native authority and the installed WebView are separate receipt rows and never inferred from the preview.
- Ledger: `usage-labels.ts` and the application menu Quit item keep their named exceptions; their provenance now
  cites this page.

## Handoffs

Capabilities that need new runtime abilities are owned by the runtime phases, never permanently refused:

- Reading usage, limits and accounts from a background service: R0204 (delivered, see
  [runtime-usage-resources.md](runtime-usage-resources.md)).
- Contributing a package-owned Settings page with its own persisted values: R0407.
- Switching accounts from a package: R0806. Consumed by R1212 through the S07C handoff rows.
