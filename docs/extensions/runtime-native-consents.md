# Native consents migration

Before the runtime, a package's consents were of two kinds: private storage, which the package settings record already
kept across restarts, and transient per-handle consents (context summaries, project files and Git, jobs, connections,
services) that lasted one captured invocation. Both now map to a permission of the [grant vocabulary](runtime-grants.md)
and to one grant in the native store (`src-tauri/src/extensions/runtime_native_consents.rs`, TypeScript mirror
`src/extensions/runtime-native-consents.ts`).

| Family | Permission |
|---|---|
| Context | `projects.summary`, `tasks.summary`, `harnesses.inventory`, `connections.summary`, `jobs.summary` |
| Project files | `projects.files.metadata`, `projects.files.read` |
| Git | `projects.git.read` |
| Jobs | `tools.execute` |
| Connections | `connections.request` |
| Services | `services.call` |
| Private storage | `storage.private` |

## Rules

- Only an explicit allow becomes a grant. A denial, a missing decision, a stale version, an undeclared permission or
  a package that is not installed never become grants.
- A permission the user can narrow by project keeps the projects it was consented in; a consent without a project for
  such a permission is dropped rather than widened. Permissions with no project scope become global grants.
- The migration is one write: every entry is validated first, and a malformed entry, a failed write or a corrupt store
  changes nothing.
- It is repeatable. Each adopted name is remembered in the grants file (`migrations`), so running it again adopts
  nothing, writes nothing, and never undoes a later revoke or narrowing by the user.
- Persisted storage consent is read from `storageGranted` of `extensions_snapshot` and survives an upgrade or restart as
  a grant; the command `extensions_runtime_native_consents` runs the migration and answers the adopted entries.

## Legacy API-1 calls

A legacy call site asks the native checker (`gate`). Without the grant the answer is the previous prompt, asked per
handle exactly as before; with it the package is never asked (ADR-0005). A revoke, a narrowing, a stale version, an
archived package and an untrusted digest all send the call back to the previous prompt, and open privileged work is
cancelled by the store. A name outside the vocabulary, including `credentials.read`, is `UnsupportedCapability`.

## Limits

The legacy brokers (`context.rs`, `jobs.rs`, `connections.rs`, `services.rs`) are not yet changed to call `gate`, and
nothing yet feeds their transient consents into the migration; those hand-offs belong to the tasks that own them
(R0203 for context). The refusal that a new inspector's webview context grant is not persisted natively stays until then.
