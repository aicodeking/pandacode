# Shared declarative primitives (experimental)

Every extension surface uses one closed control vocabulary: the package supplies JSON data and command
IDs, and PandaCode's own renderers draw the controls with the shared design tokens. There is no second
control library, and a package can never supply callbacks, markup, DOM handles, selectors or raw IPC.

The vocabulary is declared once, as `x-primitives` (contract version 1) in
[`src/extensions/schema-v1.json`](../../src/extensions/schema-v1.json). The frontend validator exposes it as
`PRIMITIVES` in `src/extensions/contracts.ts` and the native validator reads the same file
(`primitive_limit` in `src-tauri/src/extensions/contracts.rs`). Tests check that every declared kind and
limit matches the schema both validators enforce, so the declaration cannot drift from what is accepted.

## Families

| Family | Where it is written | Kinds | Limits |
| --- | --- | --- | --- |
| `action` | `menus[].presentation` | `icon` (default), `button`, `status`, `badge` | badge text 16 characters |
| `icon` | `icons[]` (package asset) or `host` fallback | `file`, `folder`, `help`, `settings`, `down`, `right`, `search`, `plus` | asset path 256; SVG/PNG/WebP inside the package |
| `menu` | `menus[].items[].kind` | `command`, `submenu`, `separator`, `checkbox`, `radio` | 5 levels, 128 items |
| `command` | `commands[].action.kind` | `showMessage` (notification), `showDialog`, `openView`, `showProjectContext`, `runCommand` | message 4096 characters |
| `field` | dialog and Settings `fields[].kind` | `text`, `textarea`, `switch`, `select` | 24 fields, 100 options, 4096 characters, textarea `rows` 2–12 (default 4), search 200 |
| `view` | `views[].controls[].kind` | `list`, `tree`, `table`, `tabs`, `progress` | 24 controls, 100 items/rows, 16 columns, 16 tabs, 16 toolbar commands |

`runCommand` needs reviewed executable trust and `showProjectContext` a project grant; both keep their
own documents ([runtime](runtime.md), [project reads](project-reads.md)).

## What each host accepts

A host advertises the primitives it can draw. Anything else is rejected by validation, shown as an
unavailable entry, or degraded as listed; nothing is assumed to fit everywhere.

| Host | Accepts | Degrades / omits / unavailable |
| --- | --- | --- |
| `actionSlot` (header, sidebar, inspector and other DOM action strips) | every action, icon, menu and command kind | — |
| `nativeMenu` (`panda.tray.menu`) | `command`, `submenu`, `separator`; `showMessage`, `showDialog` | `checkbox`/`radio` become plain commands; `status`/`badge` presentations are omitted; `openView`, `runCommand`, `showProjectContext` appear unavailable. A native dialog opens in the main window's host dialog. |
| `dialog` (`showDialog`) | every field kind | — |
| `settings` (namespaced Settings pages) | every field kind | `async` selects are rejected (`UnsupportedContribution`) |
| `inspectorView` (host-rendered views) | every view kind, toolbar commands | — |

## Textarea

```json
{ "id": "notes", "kind": "textarea", "label": "Notes", "required": true, "minLength": 3, "rows": 5 }
```

It shares the `text` value contract (string, at most 4096 characters, `required`, `minLength`) on the
frontend and natively, including Settings persistence. Enter inserts a line break and never submits the
form; IME composition (`isComposing`/229) Enter and Escape are swallowed; Escape outside composition
cancels the dialog. The field draws the same `--ds-border` hairline as the text input, resizes only
vertically and keeps a system focus outline under forced colors.

## Conformance package

[`tests/fixtures/extensions/primitives`](../../tests/fixtures/extensions/primitives/extension.json)
installs through the ordinary package flow and uses every declarative kind above: an icon button with a
validated SVG, a text button, a badge and a status, a recursive menu with separator/checkbox/radio, a
notification, a form with text, textarea, switch, select and an asynchronous multi-select, a view with
list/tree/table/tabs/progress and a toolbar, and a Settings page with a textarea.

- `tests/extensions-primitives.test.mjs`: declaration/schema agreement, host advertisements, package
  coverage, malformed/prototype/oversize/unsupported/callback/ungranted rejection, textarea state and
  disposal, Settings values.
- `tests/extensions-primitives-coverage.spec.ts` (Chromium and WebKit preview): install from zero,
  accessible names, keyboard, IME, Escape, focus return, nested menus, loading/error/retry, cancel,
  disable while pending, corrupt package fallback, listener/observer balance, and tokens under light, dark,
  increased contrast, forced colors, reduced motion and reduced transparency (Chromium only).
- Native: `primitive_declaration_matches_schema_carriers_limits_hosts_and_conformance_package` and
  `primitives_package_archive_settings_textarea_native_menu_disable_and_safe_mode`.

The browser preview is not installed WebView or native menu qualification; those remain deferred.
