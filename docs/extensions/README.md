# Extension author guide (experimental API 1.0.0)

Start here to build, validate, package and install a PandaCode extension using only what ships in
this repository: the manifest schema `src/extensions/schema-v1.json`, the type-only SDK in
`src/extensions/sdk` and the examples in `examples/extensions`. Every example installs without
changing PandaCode source. Nothing here is published to a registry, and API 1 is **experimental**:
it is not yet a stable compatibility promise (see [Compatibility, deprecation and
migration](#compatibility-deprecation-and-migration)).

## Versions

| What | Version | Where it is declared |
| --- | --- | --- |
| Public extension API | `1.0.0` (independent of the app version) | `engines.pandacodeApi` range in `extension.json`; `apiVersion` on the SDK object |
| Manifest format | `1` | `manifestVersion` |
| SDK type package | `@pandacode/extensions` `1.0.0-experimental.1` | `src/extensions/sdk/package.json` |
| Host DTOs, recipes and contracts | `1` | `schemaVersion` / `contractVersion` on every DTO, component and theme |
| Provider (harness) contract | `1` | `providers[].apiVersion` |

A required range PandaCode does not satisfy fails closed with `IncompatibleApi`; the package is
never half-activated. Accepted spellings are exact (`1.0.0`), caret (`^1.0.0`), tilde (`~1.0.0`)
and one interval (`>=1.0.0 <2.0.0`). Alternatives (`||`), wildcards and partial versions are
`InvalidVersionRange`.

## Quick start

Every command runs from the repository root after `npm ci --ignore-scripts`. No command downloads
anything at extension run time, contacts a network service or changes PandaCode source.

1. **Pick an example** from the [table below](#examples) and copy its folder for your own package.
   Rename the package ID (`publisher.extension`) and every contribution ID
   (`publisher.extension/local-id`); `panda.*` is reserved for the core.
2. **Build TypeScript sources** (only the examples with a `tsconfig.json`):

   ```sh
   npx tsc -p examples/extensions/local-tool/tsconfig.json
   npx tsc -p examples/extensions/project-summary/tsconfig.json
   ```

   In a standalone copy, point the example's `file:` dependency on `@pandacode/extensions` at your
   copy of `src/extensions/sdk`, run `npm install --ignore-scripts` and then `npm run build`.
3. **Validate** every example (manifest contract, declared files, SDK agreement, compatibility
   corpus and this guide's tables):

   ```sh
   node --test tests/extensions-examples.test.mjs
   ```

   The same corpus runs in the native installer tests:
   `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib author_examples`.
4. **Package** only the contents of the example's `package/` folder, with `extension.json` at the
   archive root (never an extra top folder, sources, `node_modules` or the SDK):

   ```powershell
   Compress-Archive -Path examples/extensions/button-icon/package/* -DestinationPath $env:TEMP/sample.button-icon.zip -Force
   ```

   Use PowerShell 7 (`pwsh`): Windows PowerShell 5.1's `Compress-Archive` can store nested paths
   with backslashes, which the installer rejects as `Unsafe archive entry.`

   ```sh
   (cd examples/extensions/button-icon/package && zip -r /tmp/sample.button-icon.zip .)
   ```

5. **Install**: open **Settings → Extensions → Install local package** and select the ZIP. The
   package is installed **disabled**. Choose **Enable**. Executable packages additionally show the
   executable trust review for this exact content; nothing runs before you accept it.
6. **Iterate** without re-zipping: **Settings → Extensions → Trusted extension development →
   Select development folder** and pick the example's `package/` folder; **Reload** after each
   rebuild. See [development](development.md).
7. **Recover** at any time: disable the package, choose **Disable extensions for this launch**, or
   start PandaCode with `--safe-mode`.

## Examples

| Example | Shows | Runs code | Try it |
| --- | --- | --- | --- |
| [button-icon](../../examples/extensions/button-icon/) | Header and sidebar-footer buttons with a static SVG icon | no | Click **Hello** in the workspace header |
| [submenu-dialog](../../examples/extensions/submenu-dialog/) | Menu trigger → submenu → dialog with text, textarea, switch, select and multi-select | no | **Reports → Reports → Configure report…** |
| [context-panel](../../examples/extensions/context-panel/) | Host-rendered inspector view (list, table, progress, toolbar) and captured project context | no | **Context panel**, then **Show project context** |
| [layout-theme](../../examples/extensions/layout-theme/) | Light/dark theme tokens and a sidebar-footer layout proposal | no | Select the theme and layout in Settings → Extensions |
| [replacement-recipes](../../examples/extensions/replacement-recipes/) | Selectable closed host recipes for Projects and Search | no | Choose them in Settings → Extensions → component selection |
| [surface-controls](../../examples/extensions/surface-controls/) | Board, action dock, sidebar Bots, Simulator, a main dialog band and the tray window | no | Open each surface; layouts in Settings → Extensions |
| [project-summary](../../examples/extensions/project-summary/) | TypeScript SDK: command registration, context query, staged dialog | yes | **SDK summary**, then allow project-summary access |
| [local-tool](../../examples/extensions/local-tool/) | TypeScript SDK: a manifest-declared local tool run as an owned job | yes | **Count words**, then allow tool execution |
| [service-provider](../../examples/extensions/service-provider/) | A versioned public service export | yes | Install before the consumer |
| [service-consumer](../../examples/extensions/service-consumer/) | Calling another package's service through the broker | yes | **Call public greeting** |
| [acp-recorded](../../examples/extensions/acp-recorded/) | A harness (provider) replaying recorded ACP frames offline | yes | Select **Recorded ACP** in the model picker |

Every family of host surface also has a small installable reference manifest next to its tests in
`tests/fixtures/extensions/<family>/extension.json`; the family documents below say which one.

## Manifest

`extension.json` is validated by the same schema and rules in the app and the native installer.
Required: `manifestVersion`, `id`, `version` (`x.y.z`), `engines.pandacodeApi`, `extensionKind`
(`ui` runs only in the window host; `workspace` may also be activated by a headless or Connect host
that has its own trusted copy), `permissions` and `contributes`. Optional: `runtime` (`kind: "node"`,
`entrypoint: "main.cjs"`, `activationEvents` = the executable command IDs), `dependencies`
(`{ "publisher.extension": "<range>" }`), `requiredContributions`, `requiredCapabilities`,
`optionalCapabilities`.

Contribution kinds:

<!-- contributions:start -->
`commands`, `icons`, `menus`, `views`, `layouts`, `settings`, `keybindings`, `dialogExtras`,
`themes`, `components`, `tools`, `connections`, `services`, `providers`, `slashCommands`
<!-- contributions:end -->

Field-by-field rules are in [contracts](contracts.md); the shared control vocabulary (actions,
icons, menus, commands, fields, view controls) and which host accepts which is in
[primitives](primitives.md). Unknown optional fields are removed with an `UnknownOptionalField`
diagnostic; a `requiredContributions` entry PandaCode does not know fails with
`UnsupportedContribution`.

## Permissions, grants, context and events

A permission declared in the manifest is a ceiling, not consent. Data and side effects also need
the user's explicit, revocable grant for that package version in Settings → Extensions; install,
enable, executable trust and selecting a recipe are each separate and none implies another.
Declaring a permission you do not need is allowed but shows in review; using a contribution that
needs an undeclared permission fails with `PermissionDenied`.

<!-- permissions:start -->
| Permission | Allows |
| --- | --- |
| `ui.contribute` | Commands, menus, icons, views, dialogs, settings pages, keybindings and dialog extras |
| `ui.customize` | Layout proposals (order within compatible sibling groups) and control-family recipes |
| `ui.richViews` | Package HTML views; native rich views stay disabled until qualified, with a host-rendered fallback |
| `storage.private` | Owner-private storage after the user's persisted consent ([storage](runtime.md)) |
| `projects.summary` | Captured project summary pages |
| `tasks.summary` | Captured task summary pages |
| `harnesses.inventory` | Installed harness inventory |
| `connections.summary` | Connection status summaries |
| `jobs.summary` | Background job summaries |
| `projects.files.metadata` | File metadata in the captured project ([project reads](project-reads.md)) |
| `projects.files.read` | Bounded reads of one exact relative file |
| `projects.git.read` | Local HEAD/Git metadata |
| `tasks.transcript.read` | Captured task transcript pages |
| `tasks.tools.read` | Captured task tool-call pages |
| `tools.execute` | Run manifest-declared local tools as owned jobs (no executable path, PID or cwd input) |
| `connections.request` | Declared HTTPS GET connection operations with host-entered credentials |
| `services.call` | Call another package's exported service through the broker |
| `btw.taskControl` | BTW side-task mutations after host-user consent ([BTW](btw.md)) |
| `btw.content` | Insert a visible BTW answer into the draft after host-user consent (never sends) |
<!-- permissions:end -->

**Context.** Every action captures its invocation once: `windowId`, `surfaceId`, optional
`projectId`/`sessionId`, `selection` and a `revision` (`InvocationContext` in the SDK). Switching
project or task afterwards never retargets pending work. Reads are bounded pages with an opaque
`revision` and `nextCursor`; a changed source returns `StaleContext` (or `ResyncRequired` on
cursors) and you start again without a cursor.

**Events.** `context.subscribe` returns a snapshot plus a cursor; `context.events` drains bounded
`progress`/`terminal` events and reports `resync: true` after a gap; `context.unsubscribe` ends it.
Every subscription also ends with the activation, disable, trust or grant revocation, or uninstall.
Service calls (`services.start/poll/dispose`) drain at most 32 events per poll.

## Locations and controls

[capabilities](capabilities.md) lists every location PandaCode serves, its operations, item types,
window and host fallbacks; it is generated from the tested catalog. Per-surface rules, eligible
controls, protected items and examples: [contracts](contracts.md) (header, sidebar footer,
inspector, views, layouts), [sidebar](sidebar.md), [settings](settings.md),
[settings actions](settings-actions.md), [core dialogs](core-dialogs.md),
[owned dialogs](owned-dialogs.md), [dialogs](dialogs.md), [composer controls](composer.md), [composer panels](composer-panels.md), [Attach menu, recipes and wake-ups](composer-attach.md), [transcript extras](thread-extras.md), [thread tiles and the draft project picker](tiles-picker.md), [slash commands and the harness command center](commands-extras.md), [Team, Task actions, Deploy and Bot menus](task-menus.md), [Workspace view, Sort and view and Filter projects menus](window-menus.md), [bot thread header, shared channel conversation controls and the bot web chat projection](bot-conversation.md), [action dock](action-dock.md),
[agent roster](agent-roster.md), [status](status.md), [windows](windows.md), [documents](documents.md),
[diff](diff.md), [search](search.md), [browser](browser.md), [terminal](terminal.md),
[simulator](simulator.md), [VM](vm.md), [design](design.md), [BTW](btw.md), [board](board.md),
[GitHub hub](github-hub.md), [pull](pull.md), [worktree](worktree.md),
[moodboards](moodboards.md), [cloud](cloud.md), [machines](machines.md),
[rich views](rich-views.md), [replacement](replacement.md), [compatibility](compatibility.md),
[catalog](catalog.md), [providers](providers.md) and [project reads](project-reads.md).

## Lifecycle

1. **Install** validates the whole archive in memory; nothing runs and the package is disabled.
2. **Enable** revalidates it with the enabled dependency graph. Executable packages require
   **executable trust** for this content hash and version first; changed bytes need a new review.
3. **Activate** is lazy: code starts only when one of its `activationEvents` commands is invoked,
   in a supervised process with a five-second invocation deadline, 64 KiB frames, 128 messages and
   16 pending calls ([runtime](runtime.md)). Registrations are disposed when the process ends.
4. **Update** is an explicit local ZIP staged, reviewed (added permissions, executable authority)
   and activated after running work drains; one prior generation is kept for **Roll back**
   ([lifecycle](lifecycle.md)).
5. **Disable** removes the package's controls without deleting its data or preferences. **Uninstall**
   removes only the installation; private data deletion is a separate action.
6. **Safe mode** (`--safe-mode` or **Disable extensions for this launch**) skips all third-party
   execution and layout overrides before packages load and keeps projects, tasks, drafts, terminals,
   credentials and saved preferences.

Errors are stable codes, never thrown host objects. A broker or host reply that fails carries one
of the codes below; an archive that fails carries one of the archive messages. Do not retry an
ambiguous mutation automatically: read the state again first.

## Troubleshooting

<!-- errors:start -->
| Code or message | Meaning | Fix |
| --- | --- | --- |
| `InvalidShape` | A field is missing, has the wrong type or a value outside its enum (for example `manifestVersion` other than `1`, or a menu `location` that is not an `action` row in [capabilities](capabilities.md)) | Compare with [contracts](contracts.md) and an example |
| `InvalidId` | A contribution ID is not `publisher.extension/local-id` for this package | Prefix every contribution ID with the package ID |
| `ReservedId` | The package uses the core-reserved `panda.*` namespace | Choose your own publisher prefix |
| `DuplicateId` | Two packages or contributions share an ID | Rename one; an installed owner cannot be shadowed |
| `InvalidVersionRange` | `engines.pandacodeApi` or a dependency range is not an accepted spelling | Use `^1.0.0`, `~1.0.0`, `1.0.0` or `>=1.0.0 <2.0.0` |
| `IncompatibleApi` | The required API range excludes `1.0.0` | Target `^1.0.0` and rebuild against this SDK |
| `IncompatibleDependency` | A dependency's installed version is outside the range | Install a compatible dependency version |
| `UnknownReference` | A referenced command, view, icon or dependency is not declared or not in the validated set | Declare it, fix the ID, or install the dependency first |
| `MissingReference` | A provider icon refers to an icon this package does not declare | Add the icon under `contributes.icons` |
| `UnsupportedCapability` | A permission or required capability is not one of the documented ones | Use a permission from the table above, or move it to `optionalCapabilities` |
| `UnsupportedContribution` | A required contribution kind is unknown, or a feature is not accepted there | Remove it from `requiredContributions` or use a supported field |
| `UnsupportedRuntime` | Runtime keys are misplaced, `activationEvents` do not match executable commands, a contribution needs `runtime`, or this app has no qualified runtime | Declare `runtime` exactly as in the executable examples |
| `PermissionDenied` | A contribution needs a permission that is not declared, or a grant is missing or revoked at call time | Declare the permission; ask the user to allow access in Settings → Extensions |
| `LimitExceeded` | A size, count, depth or text-length bound was exceeded | Reduce the data; bounds are in [contracts](contracts.md) and [primitives](primitives.md) |
| `UnsafeAsset` | An icon path is not under `assets/` or has an unsupported extension | Use `assets/<name>.svg` |
| `InvalidAppearanceContrast` | A theme's foreground/accent contrast is too low | Foreground needs 7:1 and accent 3:1 against the background |
| `OrderingCycle` | Layout rules form a cycle | Remove one `before`/`after` rule |
| `DependencyCycle` | Package dependencies form a cycle | Break the cycle |
| `StaleContext` | The captured revision, cursor or context is no longer current | Read again without the cursor |
| `Revoked` | The package was disabled, uninstalled or its grant revoked after capture | Re-enable or re-allow, then invoke again |
| `Missing extension.json.` | The archive root has no manifest | Zip the contents of `package/`, not the folder |
| `Undeclared package file; executable files and install hooks are unsupported.` | The archive carries a file the manifest does not declare (sources, `package.json`, `main.cjs` without `runtime`) | Ship only `extension.json`, `main.cjs` (with `runtime`) and declared assets |
| `Missing declared icon.` | An icon's `asset` is not in the archive | Add the SVG at the declared path (case-sensitive) |
| `Missing executable entrypoint.` | `runtime` is declared but `main.cjs` is absent | Build first, then zip `package/` |
| `Unsafe archive entry.` | An entry name is absolute, contains `..`, a backslash or a link | Re-create the ZIP from the `package/` folder |
<!-- errors:end -->

Other symptoms:

- **The button does not appear.** Check that the package is enabled, that its `location` is an
  `action` row in [capabilities](capabilities.md) for that window, and that a user layout has not
  hidden it (Settings → Extensions → Visibility and recovery).
- **Executable code does not run.** Executable trust must be accepted for this content; only Windows
  x64 with the staged app-owned Node runtime is currently qualified, other targets report
  `UnsupportedRuntime` with the reason.
- **A query is rejected although code runs.** Executable trust does not grant API access; allow the
  specific permission for the package in Settings → Extensions.
- **Development logs are empty of your output.** Raw console/stderr, paths and exception strings are
  omitted by design; return state through dialogs or the SDK instead ([development](development.md)).

## Compatibility, deprecation and migration

- API 1.0.0 is the first public API version and is experimental. There is no earlier public API
  version; manifests written for earlier deliveries of API 1 (the families listed in
  `priorFixtures` of `tests/fixtures/extensions/examples-v1.json`) must keep validating, and CI
  checks that in the app and native validators.
- Additive optional fields and optional capabilities are tolerated: unknown ones are removed with a
  diagnostic, never granted. Required unknown or incompatible contracts fail closed.
- Before API 1 is declared stable, a breaking change is announced in the release notes and in this
  guide with the replacement, its version and a migration step; a removed field first becomes an
  `UnknownOptionalField` diagnostic for at least one minor release where that is safe. A stable
  API 2 would be negotiated through `engines.pandacodeApi`; API 1 packages keep their declared range
  and are never silently reinterpreted.
- Pin `engines.pandacodeApi` and the SDK version, recompile and revalidate on every PandaCode
  update. Settings, layout choices and private data of a disabled or dormant package are kept
  through migration; irreversible public API migrations are rejected.

## Platform limits

- Executable extensions are qualified only on Windows x64 with the explicitly staged app-owned Node
  runtime. Other targets fail closed with a reason; declarative packages work everywhere the app runs.
- Executable trust grants normal user OS authority (files, credentials available to the account,
  network, processes). API permissions are enforced but are not an OS sandbox.
- Native extension-owned rich HTML windows stay disabled on every target until installed native
  isolation is qualified; the host-rendered declarative view is shown with the reason.
- Native OS menus (`panda.tray.menu`) cannot embed selects or fields, or render package SVG icons;
  forms and selects open in the main window and icons show in the tray popover.
- The VM inspector is macOS-only and local virtualization needs Apple silicon; GitHub, cloud and
  multi-machine actions are synthetic in tests and need the user's own accounts in the app.
- Browser preview tests are synthetic. Installed Windows/WebView2 and Linux interactive acceptance
  are deferred; macOS, ARM, mobile devices and real multi-machine acceptance are not yet qualified.
