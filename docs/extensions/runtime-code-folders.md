# Code folders, the service environment and the data directory

Runtime slice R0105. A trusted package's background service ([runtime-service-lifetime.md](runtime-service-lifetime.md))
can ship code in more than one file, finds the user's command-line tools, and gets a folder of its own for data.
The native owner is `src-tauri/src/extensions/runtime_code_folders.rs`; the package limits are in
`src-tauri/src/extensions/packages.rs`. The webview mirror and preview stand-in is
`src/extensions/runtime-code-folders.ts`.

## Code folders (`runtime.files`)

```json
"runtime": {
  "kind": "node", "entrypoint": "main.cjs",
  "activationEvents": ["sample.code-folders/probe"],
  "files": ["lib", "wasm"],
  "service": { "start": "onEnable" }
}
```

- `runtime.files` lists up to eight folders of the archive. Each name matches `^[a-z0-9][a-z0-9_-]*$` (at most 64
  characters). Every file inside a listed folder is package code, of any type: CommonJS, ES modules, worker scripts,
  WebAssembly, data files, native addons (loaded as Node loads them, not qualified per platform).
- A file outside `extension.json`, `main.cjs`, the declared icons and rich-view assets and the code folders is still
  refused: `Undeclared package file; executable files and install hooks are unsupported.` The reason is
  predictability: the archive is exactly what the manifest declares, so the content the user reviewed is what runs.
- Before a service starts, the host writes `main.cjs` and the code folders to
  `<app data>/extension-code-v1/<package id>/<archive checksum>/` and starts the service there: the bootstrap loads
  `main.cjs` with Node's own loader and the working directory is the code directory. `require('./lib/x.cjs')`,
  `import('./lib/x.mjs')`, `new Worker(join(__dirname, 'lib', 'w.cjs'))` and `readFileSync(join(__dirname, 'wasm',
  'm.wasm'))` resolve by relative path.
- The directory is checked against the stored archive at every start: a changed, missing or extra file rebuilds it.
  A new checksum (update, rollback) is a new directory; the other generations are removed once no process uses them.
  Uninstall removes the package's code (after its service has stopped).
- No install script runs and nothing is downloaded by the host. A service may download what it needs into its data
  directory.
- Short activations (packages without a service) still run the single `main.cjs` text from the runtime folder; they
  do not see the code folders. A service's owned commands run inside the service, from its code directory.

## The service environment

The service inherits the user's environment, so it finds the user's command-line tools. The app widens its own PATH
to the installed-tool locations at startup (`providers::launch::widen_process_path`), so a service started from the
Dock or Finder sees the same tools as a terminal. Two exceptions:

- `NODE_OPTIONS` is not passed (stability: the pinned runtime's flags are the host's).
- The host's own `PANDACODE_*` variables are not passed, and no credential PandaCode holds is ever added
  (ADR-0006: a held credential is used through the host, never handed over).

On Linux the AppImage clean-up of every external spawn (`child_env::sanitize`) applies too. Short activations keep
their cleared environment.

## The data directory (`panda.storage.directory`)

```ts
const { path } = await panda.storage.directory({ scope: 'global' });
```

- Under `storage.private`: the live native grant is checked at every call; without it the call is
  `PermissionDenied`.
- `global` answers `<app data>/extension-data-v1/<package id>/global`; `project` answers
  `.../project-<sha256 of the project id>` for the project of the call's context: inside an owned command dispatched
  into the service, the project of that command's captured context. Outside a command, or for a context without a
  project, `project` answers `StaleContext`.
- Service only: a short activation (and later a panel) is answered `UnsupportedCapability`.
- Kept across disable, update, rollback and uninstall; removed by "remove own data", which also removes the private
  key-value record. Not capped (the key-value record keeps its quota: it is one JSON file rewritten atomically).
- Showing its size on the Extensions page is not part of this slice.

## Package limits

| Limit | Before | Now |
|---|---|---|
| Archive | 2 MiB | 16 MiB |
| One file | 256 KiB | 8 MiB |
| Expanded | 1 MiB | 64 MiB |
| Files | 64 | 1,024 |
| Record | 9 MiB | two archives in base64 plus 1 MiB (45,787,824 bytes) |

The record carries the current archive and one more generation: the staged update while it waits, or the rollback
generation after it is promoted. `package_limits_hold_at_every_boundary_and_two_archives_fit_the_record_with_rollback_intact`
checks every boundary (1,024 files pass and 1,025 fail; 8 MiB passes and one byte more fails; 64 MiB expanded passes
and one byte more fails; an archive over 16 MiB fails before it is opened) and the two-generation case.

<!-- measurements:start -->
Measured on Windows x64 (debug test build, `PACKAGE_LIMITS`, 2026-11-16):

| What | Result |
|---|---|
| Largest archive tried (stored, incompressible) | 16,708,059 bytes, accepted |
| Record with the staged update beside it | 44,555,442 bytes (limit 45,787,824) |
| Record with the rollback generation after promotion | 44,555,499 bytes (limit 45,787,824) |
| A third generation (staging over B with rollback A) | refused `Extension record limit exceeded.`, record byte-for-byte unchanged, rollback to A works |
| Install 1,024 files / 8 MiB file / 64 MiB expanded / 16 MiB archive | 407 / 1,289 / 1,928 / 1,562 ms |
| Snapshot / code files of the 16 MiB package | 1,359 / 1,511 ms |
| Write the code directory / verify and reuse it | 11 / 11 ms |
| Stage / promote / roll back the 16 MiB update | 3,797 / 8,051 / 4,340 ms |

Schema-2 decision: **not needed for these limits.** Two base64 archives plus state fit the measured record limit with
rollback intact, so the record stays schema 1. The cost is time, not correctness: a 16 MiB package makes stage,
promote and rollback take seconds, because each one rewrites a 44 MB JSON record. Storing archives as separate
content-addressed files (a schema-2 record) would remove that cost. It is recorded as a follow-up and not built in
this slice. It becomes required only if the limits grow past one archive and one more generation.
<!-- measurements:end -->

## Tests

- Native, always: folder names and membership, archive admission and the retained refusal, the checksum-qualified
  directory (verify, rebuild, replace, remove), uninstall keeping data until "remove own data", the environment
  filter, the data directory answers, and the package limits with timings (`PACKAGE_LIMITS`).
- Native, real runtime (`--features extension-runtime-native-tests`, Windows x64): the fixture
  `tests/fixtures/extensions/runtime-code-folders/` is installed and its service imports CJS, ESM (which imports a
  sibling), a worker and Wasm from its folders, reports its environment (PATH present, `NODE_OPTIONS` and a canary
  `PANDACODE_*` variable absent, a user variable present) and its data directory, then keeps its data across an
  update (new generation, old directory removed), a rollback and an uninstall (code removed, data kept).
- Browser preview: `tests/extensions-runtime-code-folders.spec.ts` in Chromium and WebKit checks the webview mirror.
