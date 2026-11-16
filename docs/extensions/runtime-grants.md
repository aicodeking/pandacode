# Runtime grants

What the user granted to a package is kept natively, in one file, and every native call site asks it. The
webview only reads it and sends the user's changes. A manifest `permissions` list is a ceiling; a grant is what a
call needs ([ADR-0005](../../_work/10-docs/adr/0005-trust-in-the-author-not-restriction.md): trust in the author is
given at install, and a package holding the permission is never asked again per action).

## The vocabulary

Fifty names, in one list shared by the manifest validator and the grant store (`PERMISSIONS` in
`src-tauri/src/extensions/runtime_grants.rs`, `MANIFEST_CAPABILITIES` in `src/extensions/contracts.ts`,
`ManifestPermission` in the SDK, the table in the [guide](README.md#permissions-grants-context-and-events) and
`tests/fixtures/extensions/examples-v1.json`). A name outside it fails with `UnsupportedCapability`. There is no
`credentials.read`: the host attaches a held credential to a request a package declared (`credentials.use`) and the
value never reaches a package, a panel or the webview.

## The file

`extension-grants-v1/grants.json` in the application data directory. It is independent of SQLite and of
`storage::SCHEMA_VERSION`. Writes are staged and renamed; a malformed or unknown-name file is kept byte for byte,
answers `PermissionDenied` to every check and refuses every change (`MalformedData`), so damage never turns into a
grant.

Per package it holds the installed `version`, the `declared` names, the executable `digest` and the
`trustedDigest`, `archived`, and `grants`: a name with a scope.

| Scope key | Applies to | Absent means |
| --- | --- | --- |
| `projects` | the permissions the user can narrow per project (every task, hook, workspace, terminal, document, read and `projects.checks.run` permission) | every project |
| `toolKinds` | `harness.hooks.decide` | every tool kind |
| `items` | `credentials.use` | every credential item the package declared |

## Checks

`RuntimeGrants::check(id, version, permission, target)` is the one gate. It answers `PermissionDenied` when the
package or the grant is missing, the version is not the one granted, the package is archived, disabled, in safe mode
or its executable is not trusted, or the target is outside a narrowed scope (a narrowed grant also refuses a call that
names no project). `begin` checks and registers privileged work; revoke, narrowing, untrust and archive cancel the
work they no longer allow and refuse new calls before any code starts.

- **Restart.** The store reads the file again; grants of a name still declared survive.
- **Update.** The same name keeps its grant, a removed name loses it, a new name is ungranted. A changed executable
  digest keeps the grants but is untrusted until reviewed again.
- **Narrow.** Only to a subset; never wider. Granting again replaces the scope (the user may widen).
- **Revoke.** `revoke` removes one name, `revokeAll` all of them.

## Read projection

`extensions_runtime_grants` brings the store in line with the installed packages (installs, updates, trust, enabled
state, uninstalls) and returns `{ schemaVersion: 1, available, revision, vocabulary, packages }`. Each package has
`declared`, `grants: [{ permission, scope }]`, `authorized`, `trusted`, `archived` and `uiCustomize`, the persisted
`ui.customize` grant the webview reads. `extensions_runtime_grant` takes `{ op: 'grant' | 'narrow' | 'revoke' |
'revokeAll', id, permission?, scope? }` and answers the new projection. Both are main-window commands. The reader
`parseGrants` in `src/extensions/runtime-grants.ts` reports an unknown shape as unavailable; the preview store there
is a labelled synthetic stand-in driven by the same `tests/fixtures/extensions/runtime-grants/scenario.json` as the
native test. The Extensions page and the install and update review are built on this in R0101B.
