# Trusted extension development (experimental API 1.0.0)

Development is separate from [production installation](runtime.md). It never rebuilds
PandaCode or reloads core harnesses. Only Windows x64 with the explicitly staged and
verified app-owned Node runtime is currently qualified; an unstaged/other-target app
fails closed. Preview is synthetic, not installed WebView acceptance.

## Build the standalone example

The type-only package in `src/extensions/sdk` is `@pandacode/extensions`. It has no
runtime dependency, private-module re-export or install hook. Copy/install that package
locally for external authoring; it has not been published to a registry. Its complete
PandaCode license travels with it. The API version is independent of the app version;
the experimental SDK package version is `1.0.0-experimental.1`.

From this checkout after `npm ci --ignore-scripts`:

```sh
npx tsc -p examples/extensions/project-summary/tsconfig.json
```

Or in a standalone copy of `examples/extensions/project-summary`, adjust its local
`file:` SDK dependency to your copy, install its declared development dependencies with
scripts disabled, then `npm run build`. No private PandaCode module is imported. Only
`main.cts` and the public SDK types participate; `types: []` excludes ambient app/browser
dependencies. Bundled dependencies must fit in the single compiled `main.cjs`; no runtime
dependency downloads, package-manager execution or install hooks are supported.

## Select, trust, run, reload

1. Open Settings → Extensions → Trusted extension development. Click **Select
   development folder** and choose the example's **package/** directory, not its source
   directory. The native picker action is explicit; there is no workspace scan/watcher
   that auto-opts a folder into execution. Selections last only this app launch.
2. PandaCode snapshots all bounded regular files into an immutable archive, then runs the
   **same** package/API/asset validator as ZIP installation. No code runs during selection.
   Invalid paths, links/junctions, undeclared files, unsafe SVG, unknown permissions and
   incompatible required API versions fail closed. An installed owner cannot be shadowed.
3. Review executable trust: normal-user file writes, account-available credentials,
   networking and starting programs are available to trusted code. API permissions are
   not an OS sandbox. Consent applies to this content hash/version, not its folder forever.
4. Enable explicitly, then invoke **SDK project summary**. Activation stays lazy. The
   command captures its invocation once; separately allow project-summary API access.
   With no API consent the broker rejects the query even though code is executable-trusted.
5. Rebuild the example and click **Reload sample.sdk-summary**. Only that owner's managed
   invocation, context handles, quarantine and contributions are invalidated. Other
   packages and core agents/tasks/drafts remain intact. Unchanged bytes retain enable/trust;
   changed bytes require trust review and enable again. Failed validation disables the
   selection rather than retaining an active stale revision. No live path is executed.

Logs are bounded to 32 host phase messages per selection (at most eight selections).
They show validation, lazy admission, completion/failure and reload. **Raw extension
console/stderr, paths, source, context values and exception strings are omitted entirely**,
not heuristically scrubbed for familiar secret formats. Do not use these logs as evidence
that trusted native code cannot write secrets elsewhere under its normal OS authority.

The SDK exposes invocation-scoped `commands.register`, immutable captured DTOs,
`context.query/subscribe/events/unsubscribe`, and `ui.showDialog`. Register only the
manifest-declared command selected by this invocation. Registration is disposed when
the supervised process ends; it does not mutate global registries or grant API authority.
`showDialog` stages one schema-validated DTO and resolves on admission, **not** on user
confirmation. Pending UI is delivered only after successful completion and reauthorization.
No DOM, Tauri IPC, raw database, secret store or implicit consent method is public.

Development uses the identical native broker channel, executable-trust recheck, cancellation,
five-second invocation deadline, 64 KiB frame bound, 128-message bound, 16 pending calls,
64 MiB V8 old-space and 384 MiB Windows job-memory resilience budgets as packaged code.
These are managed-work limits, not confinement of deliberately hostile trusted native code.

## Production installation and compatibility

ZIP only the contents of **package/** (`extension.json`, generated `main.cjs` and declared
assets) and install through **Install local package**. Do not include TypeScript sources,
node_modules, SDK files or build configuration in the extension archive. Production uses
the same manifest schema `src/extensions/schema-v1.json` and native validation, not the
TypeScript types as authority. Required incompatible API contracts fail closed. API 1 is
experimental: pin the SDK/API range, recompile and revalidate on update; there is no stable
v1 compatibility promise yet. Preserve dormant extension settings during migration.

Rollback: disable/uninstall just the selected development owner, or use protected
**Disable extensions for this launch**. That bypasses third-party execution without
clearing projects, running core harnesses, history, drafts or credentials. Trust revocation
stops future managed work where possible; it cannot undo prior OS effects.
