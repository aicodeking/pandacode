# Runtime preview

`src/extensions/runtime-preview.ts` runs the logic of a background service in the browser preview, so a package author
and the browser suites can exercise the same public calls without the native host.

## Preview evidence, not native

Everything this runner reports is **Preview evidence**: it is labelled `column: "preview"` (`evidenceLabel()`), it is
**not native**, and it never stands for a native installation. A package installed in the app is qualified by the
native tests (`cargo test`, the installed-service tests) and by installed or live qualification; the receipt keeps the
preview, native fixture and installed columns apart, and a missing native result stays pending.

## What it does

- Loads the service module named by the manifest's `runtime.entrypoint` from a table of known fixture modules the caller
  hands in (`Loaders`): one normal dynamic `import()` per entry. An entrypoint outside the table is `NotFound`. There is
  no `eval`, no dynamic code from text and no `blob:` module (the app CSP forbids them), and a fixture module has no
  Node imports; it receives only the `panda` object and a `lifetime`.
- Gives that `panda` the browser twins of the native slices and drives them, never copies them: workspace events
  (`runtime-workspace-events`), settings and content resources (`runtime-content-resources`), usage
  (`runtime-usage-resources`), live items (`runtime-dynamic-items`), dialogs and reveal (`runtime-dialog-navigation`),
  and notifications (`runtime-notifications`). The same grant, shape and bound rules give the same failure codes.
- Answers `panda.daemon` with B1's browser-importable core (`tests/fixtures/extensions/backends/core/fake-daemon.mjs`):
  the replaced backend. No process is spawned and no socket opened.
- Rechecks the grant on every call (`holds`), so `revoke(permission, keep?)` narrows or removes it at once: notices and
  live items of a package that lost `ui.notify` or `ui.dynamic` leave, events stop being queued, and losing
  `runtime.service` stops the service (`trust`).
- Reproduces the lifecycle: `stop(reason)` cancels the open dialog, drops live items and notices, detaches events and
  topics, then runs the service's own cleanups newest first; a throwing cleanup is recorded in `faults` and never blocks
  the others. Disable, safe mode and trust loss stop it with their reasons; a service that fails while starting is
  disposed and reported as `failed`. `stop` is repeatable.

## What it does not do

It never reaches native code, files, processes or the network. It has no operating-system notification path, so notices
answer `unavailable`, as the app does. It does not replace the native supervision, restart or parking rules
(`runtime-service-supervision`), which have their own preview.

## Extending it

A later namespace adds its calls to `buildPanda` with a short edit and its twin; there is no second preview runner. The
spec is `tests/extensions-runtime-preview.spec.ts` (Chromium and WebKit), the fixture is
`tests/fixtures/extensions/runtime-preview/`.
