# Native consent of the BTW and family controls

Runtime phase R1. Before it, the consent of the two BTW controls and of the six control families was a boolean in a
webview closure. The authority is now native: `src-tauri/src/extensions/runtime_family_consents.rs`, one command,
`extensions_family_consents`, and one file, `extension-family-consents-v1/consents.json` in the app data directory
(independent of SQLite and of `storage::SCHEMA_VERSION`). The webview client and the labelled preview are
`src/extensions/runtime-family-consents.ts`; both run `tests/fixtures/extensions/runtime-family-consents/scenario.json`.

## Families and the permissions that cover them

| Family | Covering permission(s) | Where it lived |
|---|---|---|
| `btwContent`, `btwControl` | `btw.content`, `btw.taskControl` | `btw-panel.ts` |
| `machineControl` | `tasks.control` | `machines-host.ts` |
| `cloudControl`, `moodboardControl`, `branchControl`, `pullControl` | `workspace.manage` | `cloud-host.ts`, `moodboard-host.ts`, `worktree-host.ts`, `pull-host.ts` |
| `taskControl` | `tasks.start` and `tasks.control` (both) | `board-host.ts`, `github-hub-host.ts` |

## Rules

- **A package that holds the permission is never asked** (ADR-0005). The gate answers `granted` from the native grants
  store, bounded to the project the grant was given for.
- **An API-1 package that does not declare the permission keeps the prior host choice.** The gate answers `prompt`
  with a single-use ticket; the user's choice presents that ticket and is stored natively under the package, family and
  project, so it survives a restart. A package that does declare the permission gets (or loses) the native grant from
  the same choice. Safe mode, a disabled, archived or untrusted package carries no authority and always prompts.
- **A forged consent is rejected natively.** A request that asserts a consent, a confirmation or a permission
  (`consent`, `granted`, `confirmed`, a family name, `permission`, ...) answers `PermissionDenied` and changes nothing; a
  choice or a confirmation without a ticket the native gate minted for that package, or with a used or wrong-kind
  ticket, is `PermissionDenied` too. The decision never comes from the request, only from the store.
- **Irreversible deletion confirms by default.** `projects.remove`, `tasks.remove`, `bots.remove`, `channels.remove`,
  `recipes.remove`, `wakeups.remove`, `cloud.machines.remove`, `worktrees.remove`, `branches.remove`,
  `moodboards.remove` and `pulls.merge` need the covering permission and then return `confirm` with a ticket. A
  refusal answers `Cancelled`; an acceptance re-checks the authority (it may have been revoked while the dialog was
  open). The user can turn the confirmation off for only this package (`op: "preference"`); the default is not stored.
- **Pairing a machine and granting remote access are user-only.** They are not families: `pairing`, `pair` and
  `remoteAccess` answer `PermissionDenied` to every package.
- A corrupt consents file is kept as it is, stores nothing and answers `prompt`; a failed write changes nothing.
  Uninstalling a package drops what was stored for it.

## Request shapes

`{ op: "gate", id, family, project? }` answers `{ decision: "granted" }` or `{ decision: "prompt", ticket }`;
`{ op: "choice", ticket, allow }`; `{ op: "delete", id, action, project?, what? }` answers `proceed` or `confirm` with a
ticket and a sanitized description; `{ op: "answer", ticket, accepted }`; `{ op: "preference", id, confirmDeletions }`;
`{ op: "projection" }`.

## Limits

Package code never reaches the webview, so the ticket protects against a package or a stray request asserting a
decision; it is not a defense against a compromised host UI. The existing hosts still read their own switches until
they call this command (the controls and the confirmation dialogs are wired in the runtime adapters, R4).
