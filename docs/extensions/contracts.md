# Extension contracts v1 (experimental)

This is the **data contract**, not an executable SDK or a grant of access. M0 validates packages without installing,
activating or rendering them. No extension code, install script, native library, network request or process runs.
Archive extraction, SVG/content sanitization, lifecycle registries and native broker authorization are separate gates.
Do not treat successful validation as trust, a user grant, or proof that an asset exists or is safe to display.

## Normative sources and compatibility

- [`src/extensions/schema-v1.json`](../../src/extensions/schema-v1.json) defines the supported JSON Schema subset.
  TypeScript and Rust interpret this **same file**; it is not a preview mock or a schema downloaded at runtime.
- [`tests/fixtures/extensions/contracts-v1.json`](../../tests/fixtures/extensions/contracts-v1.json) is the versioned
  acceptance corpus. Both implementations execute every case and compare the complete sanitized result, diagnostic
  order or stable error envelope. Expected values are checked in; tests do not generate/approve them.
- [`sample-project-helper/extension.json`](../../tests/fixtures/extensions/sample-project-helper/extension.json)
  is the plan's actual declarative sample, with a local icon. It needs no runtime or bundled dependencies.
- `src/extensions/contracts.ts` exports `validateContract(kind, json)` and `evaluateCondition(ast, context)`;
  `src-tauri/src/extensions/contracts.rs` supplies their native counterparts. They return copied JSON data only.
  A batch's computed orders are suggestions for later activation/rendering, not side effects.

`manifestVersion: 1` versions manifests. Registry command/contribution/surface, invocation context and errors use
`schemaVersion: 1`. The independently negotiated PandaCode API is currently `1.0.0`. Future incompatible changes
require a new version and fixtures in **both** validators; do not silently change v1 meanings. Additive optional
fields are accepted with `UnknownOptionalField` and **removed** from the returned data, recursively. Consumers must
use the sanitized value, not recover ignored fields from the original JSON. Unknown fields inside actions,
expressions, error envelopes, payload schemas and surface policies are rejected, since those shapes affect behavior.

Only `packages`, `command`, `contribution`, `surface`, `context`, `error`, `expression`, `dialog`,
`selectOptions`, `view`, and `viewControl` are public validation
kinds. Internal schema definitions (including the manifest shape without graph/ownership checks) are not separate
activation entry points. No current API registers or invokes a command merely by passing a DTO to this validator.

## Packages, identities and requirements

An extension ID is `publisher.extension`: two lowercase ASCII components beginning with a letter, followed by
letters, digits or hyphens. Contribution IDs are `publisher.extension/local-id`, with the same local component
grammar. Total length is at most 160 Unicode scalar values (these IDs themselves are ASCII). `panda.*` belongs to
core; third parties cannot claim it. Every command, icon, menu and view in a package must be owned by that package.
Contribution IDs are unique **across contribution kinds**, not just within one array. A batch cannot contain the
same package ID twice, even with different versions; active-version pinning is a later lifecycle concern.

Versions are stable `major.minor.patch`, each component 0–999999, without leading zeroes, prerelease or build suffix.
The deliberately bounded v1 range grammar is one exact version, `^version`, `~version`, or `>=version <version`.
There is exactly one space in the interval form. Wildcards, alternatives, arbitrary comparator lists, whitespace
padding and npm tags are invalid. Caret respects zero-major compatibility (`^0.2.3` ends before `0.3.0`,
`^0.0.3` before `0.0.4`); tilde ends before the next minor. Empty/inverted intervals are invalid.

`dependencies` maps package IDs to those ranges. All dependencies must exist in the submitted batch and match.
Dependency edges precede dependents; ties use ASCII ID order, independent of input order. Cycles fail the batch,
with the sorted blocked IDs (including dependents blocked behind a cycle). Errors never partially register a batch.
Later lifecycle code can use separate validated batches to isolate an affected dependency component.

`permissions` and `requiredCapabilities` contain only currently recognized names: **`ui.contribute`**, **`ui.customize`**. Unknown
entries fail with `UnsupportedCapability`. `optionalCapabilities` may contain future names, but unknown names are
removed with `UnknownOptionalCapability`. Even a recognized optional capability does not substitute for a required
permission. A nonempty known contribution requires an explicit `ui.contribute` declaration. None of these arrays
is a user grant; a future native broker must authenticate identity and authorize every sensitive invocation.

`requiredContributions` contains known keys (`commands`, `icons`, `menus`, `views`, `layouts`). An unknown required key fails
with `UnsupportedContribution`; unknown optional keys under `contributes` are diagnosed and removed. `entrypoint`,
`activationEvents` and `scripts` are explicitly rejected with `UnsupportedRuntime` even if empty. Future executable
packages require separate runtime qualification; adding an unknown metadata field cannot enable execution.

## Definitions and registry metadata

Manifest `contributes` holds the following bounded definitions:

| Definition | Fields / meaning |
|---|---|
| Command | Owned `id`, `title`, optional declared `icon`, `action`. `{kind: "showMessage", message}`, `{kind: "showDialog", dialog}`, `{kind: "openView", view}` and the separate captured `showProjectContext` / trusted-runtime `runCommand` adapters. No JavaScript source/string, shell command or private built-in command dispatch in the declaration. |
| Icon | Owned `id`, `asset`: relative `assets/…` path ending in `.svg`, `.png` or `.webp`; ASCII letters/digits/underscore/dot/slash/hyphen only. No empty, `.` or `..` segments, backslashes, percent encoding, absolute/URL paths. This checks the reference, **not the file contents**. |
| View | Owned `id`, `title`, static `text`, optional bounded `controls` and `toolbar`. Installed as a main-window inspector tab. No HTML, script, DOM handle or renderer promise. |
| Menu contribution | Owned `id`, one of `panda.workspace.header.actions` / `panda.sidebar.footer` / `panda.inspector.actions` (when open), declared `command`, optional declared `icon`, `group`, `order`, `before`/`after` IDs, `visible`/`enabled` AST and recursive `items`. |
| Layout proposal | Owned `id`, `title`, action-slot `location`, bounded `rules: [{id, target, side: "before" or "after"}]`. Requires both `ui.contribute` and `ui.customize` declarations. Cycles are rejected by both validators. |

Command/icon/view references must exist in the same package. Ordering references may name another package's menu
in the same submitted batch and location. Missing/cross-location targets fail. Topological order resolves explicit
constraints first, with location, group (default empty), numeric order (default 0), then ID as deterministic ties.
Text ties use Unicode scalar order in both implementations. Cycles fail with `OrderingCycle` and sorted blocked
IDs. Validation has no persistence side effects; the host's user overlay takes precedence over suggestions.

### Host-rendered inspector views (M6, experimental)

`contributes.views` accepts up to 32 views. Each has a namespaced `id`, `title` (1–256
characters), `text` (up to 4096), optional `toolbar: [{command}]` (up to 16 same-package
command references), and up to 24 `controls`. Every control has `kind` and an accessible `label`:

- `list`: `items` contains up to 100 text strings.
- `tree`: up to 100 `items` per level, each `{label, children?: [...]}`. The shared data
  depth/node/byte bounds apply to the whole package. Arrow keys expand/collapse/navigate.
- `table`: 1–16 text `columns` and up to 100 text-array `rows` (at most 16 cells each).
  Missing cells render empty; cells beyond the declared columns are not rendered.
- `tabs`: 1–16 `items: [{label, text}]`; host-owned selection and Arrow/Home/End navigation.
- `progress`: integer `value` from 0 through 100.

All labels/content are plain text, not Markdown/HTML or callbacks. The shared schema
validates these definitions in both TypeScript and Rust. An `openView` action names an
owned declared view. The toolbar captures project/task context on mount, rechecks command
conditions/ownership on invocation, and disposes listeners/transients on view/context
switch, hide, close or disable. It never owns project tasks, file sessions or PTYs.

The public catalog location is `panda.inspector.views`; contributed item IDs are the view
IDs themselves. Existing global/project visibility and same-owner order overlays apply.
Built-in IDs/defaults remain stable. Saved valid-but-unavailable extension IDs stay dormant;
Changes is the deterministic fallback. Re-enable/reinstall restores selection unless the
user explicitly selected another tab in the meantime. Saved open intent and layout overlay
remain separate. This slice adds no HTML views, arbitrary windows, cross-container moves,
replacement contracts or polling API. Native/platform UI qualification remains experimental.
The installable fixture is `tests/fixtures/extensions/data-panel/extension.json`.

### Nested menus (M3, experimental)

A menu contribution without `items` keeps its existing direct-command behavior. With `items`, its declared
command supplies the trigger title; opening the menu does **not** invoke that command. Each child has a unique
package-owned `id` and `kind`: `command`, `submenu`, `separator`, `checkbox` or `radio`. Non-separators require
`title`, optionally declare `icon` and `visible`/`enabled` expressions. Commands/checkboxes/radios require a declared
`command`; submenus instead require an `items` array and cannot invoke a command. Checkboxes/radios accept
`checked`; radios require a sibling-scoped `group` with at most one initially checked item. Separators allow only `id`, `kind` and optional `visible`.
Unknown child fields and incompatible variant fields are rejected, not silently executed.

Both validators limit each contributed menu to **five levels and 128 total children**, including separators and
hidden items. IDs remain unique across the entire package, including nested children. The general JSON depth/node
budget also rejects cyclic/non-JSON host objects before rendering. The shared renderer independently bounds host
trees. Filtering removes empty submenus and leading/trailing/repeated separators. Missing decoded assets use the
host help icon with a diagnostic; package markup never becomes a public rendering callback.

Right opens a child and Left returns (mirrored in RTL); Up/Down/Home/End move within a level; Enter/Space activate
once. Escape closes one level, then restores the original trigger. Menus flip or cascade vertically within narrow
viewports and retain the branch while crossing pointer gaps. Checkbox/radio state is activation-local, not a
settings/storage API. Every leaf invocation rechecks the root and all ancestor conditions against the captured
opening context. Disable/uninstall/recovery closes the complete tree and invalidates callbacks; a removed trigger
hands focus to a surviving visible host control. OS-native menus and secondary windows are not qualified here.

`tests/fixtures/extensions/menus-v1.json` is the shared three-level laboratory item tree, to be combined with the
sample package's header or sidebar contribution (not duplicated within one package, since IDs are unique).

### Dialogs and quick picks (M3, experimental)

`showDialog` supplies bounded `title`, `fields`, `successMessage`, optional `confirmLabel`, `confirmation`
and `cancelMessage`. Up to 24 unique local-ID fields may be text or textarea (4096 characters; textarea
`rows` 2–12), boolean switch or single/multi-select (100 unique label/value options, optional disabled/async/search behavior). The shared
`dialog` and `selectOptions` contracts validate direct host DTOs and the identical embedded manifest data.
Package code/callbacks/HTML are never accepted. Both native/frontend validators reject malformed variants,
duplicate identities and executable fields. See [dialogs.md](dialogs.md) for the exact field vocabulary,
host-only asynchronous transport, cancellation/validation/focus semantics and current runtime/platform limits.
The installable `tests/fixtures/extensions/menu-laboratory/extension.json` demonstrates the complete flow.
The schema's `x-primitives` declaration lists every shared primitive, its limits and the hosts that accept
it; see [primitives.md](primitives.md) and the combined `tests/fixtures/extensions/primitives` package.

### Selecting and reordering layouts (M2, experimental)

Settings → Extensions → Surface explorer lists proposal ownership, version, location, relative rules and competing
owners. Enabling a package does not apply its layout. **Grant UI customization and select** is explicit consent for
that proposal; only the selected enabled proposal can suggest order in its location. Activation order never breaks
a tie. Disable extension layouts suppresses all suggestions without clearing user preferences or package data.
Disabling the selected package restores built-ins plus the user overlay, not another competing package's proposal.
Selection remains dormant for re-enable. Global/project user orders override proposals (project wins).

Drag an order row, press Alt+Up/Down, or activate its before/after buttons. These paths share one relative-order
reducer and persist stable IDs separately from core session storage. Missing saved IDs remain dormant. Ordering
reuses live sibling nodes and preserves focus/listeners; responsive host rules still determine which physical
action group a control occupies. Reordering never moves a control between owner groups or between containers.
Header controls separated by responsive placement retain dormant relative preferences until they share a host.
Inspector and general view movement is **unsupported** until a host-owned state contract exists, not disguised
as toolbar reordering. The fixtures `layout-a/extension.json` and `layout-b/extension.json` demonstrate competing
footer proposals without scripts, commands, assets or network access.

A public registry `command` or `contribution` wraps a manifest `definition` with `schemaVersion` and `owner`:
`{extensionId, version, activationId}`. Owner IDs are validated and must own the definition. Commands also declare
`capability: "ui.contribute"`, `contexts` (window/project/session/selection), `inputSchema` and `outputSchema`.
V1 declarative commands accept no payload and return no data: both payload schemas must be `{type: "null"}`.
There is deliberately no arbitrary schema evaluator or executable callback in a public DTO. The host will later
map fixed actions to existing services. Runtime disposable ownership must follow this scope; v1 metadata does not
implement disposal itself or authenticate an owner supplied by untrusted code.

Surface DTOs have core `owner: "panda.core"`, `id`, `kind: "actions"`, optional `parent`, allowed `itemKinds`,
`windows`, `platforms`, `contexts`, `policies` (hide/reorder/replace), `defaultPosition`, and `accessibilityLabel`.
They describe capabilities; no DOM selector/node, callback, bridge or permission is exposed. Validating metadata
does not make a surface exist or change built-in policies. The broader surface ledger is an inventory, not a
promise that its many future adapters are registered in M0.

## Invocation context and data expressions

Contexts require `{schemaVersion: 1, windowId, surfaceId, revision}` with optional `projectId`, `sessionId` and
`selection: {kind: "file" | "task" | "project", ids: string[]}`. An absent project is valid; explicit null IDs
are not. Revisions are nonnegative safe integers. Context validation copies the DTO but does not query live state:
callers must capture it once when the user invokes an action, rather than retargeting to a newly selected project.

Conditions are **JSON ASTs**, not JavaScript, strings to evaluate, regexes or property paths:

```json
{ "op": "all", "args": [
  { "op": "has", "key": "projectId" },
  { "op": "not", "arg": { "op": "eq", "key": "revision", "value": 2 } }
] }
```

Allowed identifiers: windowId, surfaceId, projectId, sessionId, selection.kind, revision. Allowed expressions:
booleans, `has`, strict `eq` with a string/nonnegative safe integer literal, `not`, and nonempty `all`/`any` arrays
(at most 16 operands per node). There is no coercion (`1` differs from `"1"`), property traversal beyond the named
selection identifier, function call, assignment or JavaScript evaluation. Missing keys fail equality and `has`.
`visible`/`enabled` only describe presentation; neither can authorize, revoke or replace a native precondition.

## Limits, errors and verification

Bounds apply to the entire JSON input, **including ignored fields**: a 262144-byte JSON data budget,
depth 32 (root depth 0), 8192 value nodes. The budget counts compact UTF-8 JSON string/key/boolean/null/punctuation
bytes, charging each number 32 bytes independently of its source spelling. This conservative accounting avoids
JavaScript/Rust floating-point serialization differences at the boundary. Only valid Unicode scalar text is data.
A raw-file/IPC caller must additionally bound bytes **before
parsing**; this module cannot recover source length or duplicate JSON object keys from an already parsed value.
At most 64 packages/batch; per package 128 commands/menus/icons and 32 views; 64 dependencies and requirement/order
IDs per list; 100 selected IDs. General nonempty text is at most 256 scalar values, action/view text 4096, IDs 160,
versions 32, order/defaultPosition −100000…100000, revisions/literals 0…9007199254740991. Schema bounds are normative.
Action/expression union mismatches return `InvalidShape`; global bounds always fail first with `LimitExceeded`.

Failure: `{ok: false, error: {schemaVersion: 1, code, path, ids}}`. Success:
`{ok: true, value, diagnostics}`. Errors use stable codes, paths rooted at `$` and bounded ID lists, not localized
messages, raw exceptions, stack traces or sensitive values. Error paths truncate to 512 scalar values; lists to
64 IDs. Paths use slash-delimited field/index names for diagnostics, not JSON Pointer decoding. Public API error
envelopes additionally permit `requestId`; the validator itself does not invent request IDs.

Specific validation codes include `InvalidShape`, `LimitExceeded`, `InvalidId`, `ReservedId`, `DuplicateId`,
`InvalidVersionRange`, `IncompatibleApi`, `IncompatibleDependency`, `DependencyCycle`, `OrderingCycle`,
`UnknownReference`, `UnsupportedCapability`, `UnsupportedContribution`, `UnsupportedRuntime`, `UnsafeAsset`,
`PermissionDenied`. Broker-facing codes already have versioned envelopes (`NotFound`, `StaleContext`, `Conflict`,
`Cancelled`, `Timeout`, `HostUnavailable`); declaring those shapes does not implement the broker.

Run `node --test tests/extensions-contracts.test.mjs` and
`cargo test --locked --manifest-path src-tauri/Cargo.toml --lib extensions::contracts`.
The full product build, Node and native suites remain regression gates. No browser/UI or native isolation claim
can be inferred from these pure contract tests. API/platform support remains experimental pending later milestones.
