# Attributed notes and protected-dialog extras (runtime slice R1003)

Native owner: `src-tauri/src/extensions/runtime_protected_presentation.rs`. Webview and preview twin:
`src/extensions/runtime-protected-presentation.ts`. Fixtures: `tests/fixtures/extensions/runtime-protected-presentation/`
(`extension.json`, the package `sample.protected-notes` naming the eight dialogs; `no-grant.json`, the same idea without
`ui.presentation`, which the manifest check refuses; `cases.json`, the policy, note and row cases both twins read; all
`synthetic`). Spec: `tests/extensions-runtime-protected-presentation.spec.ts` (preview/Node column). Native:
`runtime_protected_presentation::tests`.

Permission `ui.presentation` (global), rechecked when the extra is drawn. No confirmation per action (ADR-0005). Everything
here is for fault isolation and predictability, never for trust.

## Hook notes on tool and approval rows

A `tool.before` hook may return a `note` next to its decision (R0505; the note needs `ui.presentation`, otherwise the receipt
refuses it with `PermissionDenied`). The host now builds one row per call from the fold:

- each note is one line `<package name>: <note>` and keeps the name of the package that wrote it, even when another package
  decided;
- the decision line names the package that decided: `<tool> approved by <name>[ with rewritten arguments]. <reason>`,
  `<tool> denied by <name>. <reason>`, or, for an ask, `<name> asks you to decide: <reason>` (a hook that failed under an
  `ask` failure policy reads `<reason> Decide yourself.`);
- the deciding package must be the one the host recorded for the call (`decidedBy`, also reported to `tool.after`). If the two
  ever differ, the decision label is withheld and the notes stay (`reconcile`); the native decision itself is never touched.

Where the lines go: an approve or deny the host already acted on is written to the transcript as before; the lines of an
`ask` or of a call nobody decided are appended to the approval prompt's own text (`prompt_suffix`), so the row the user
answers carries them. Lines are plain text, one paragraph each (`drawRowNotes`, role `note`, label "Extension notes").

## The eight dialogs

`contributes.dialogExtras[].dialog` now also accepts these dialogs, each with its captured target:

| Dialog | Target | Opened by |
|---|---|---|
| `remove-project` | project | main modal |
| `delete-task` | task | main modal |
| `delete-bot` | none | main modal |
| `delete-cloud` | none | main modal |
| `provider-connections` | none | main modal |
| `worktree-cleanup` | task | worktrees module |
| `machine-link` | none | machine orchestration module |
| `skill-add` | none | Skills manager (direct dialog) |

They use the band of every eligible dialog (`docs/extensions/core-dialogs.md`, `owned-dialogs.md`): owner-labelled notes and
secondary actions after the host content, outside every form. So the host's fields, primary action, confirmation, Escape
policy and initial focus stay where the host put them, and Enter in a host field or a pending host submit never reaches the
band. A package must hold `ui.contribute` and `ui.presentation` to show in one of the eight (`ui.contribute` alone is enough
for every other dialog); a manifest that names one without `ui.presentation` is refused with `PermissionDenied` by both
validators. At most 8 notes are shown per dialog across packages, in the user's package order then by package id; the rest is
summarized as a count.

Two dialogs stay as they were:

- `github-behind` stays built-in: it is the start-anyway recovery choice and must work when a package is what is broken. No
  package content, no schema id.
- `extension-form` stays the owning package's alone: another package's content is never placed inside it.

## A slow or broken extra

The host dialog never waits for an extra. The band is drawn after the host content and every failure while drawing it leaves the
dialog complete. `isolate` runs one package's extra with a budget of 1,500 ms and turns a rejection, a panic or a missed
deadline into `Failed` or `Timeout`; the caller keeps its own decision, so the confirmation, the credential entry and the
recovery path are never changed by an extra.

## Disable, revoke, safe mode

The band redraws on every extensions change. A disabled package, a revoked `ui.presentation` or safe mode removes its notes and
actions at the next draw (no restart), and with no package the dialogs are exactly the built-in ones. Row notes of an already
finished call stay in the transcript as the plain text they were saved as.

## Retained refusals (R1003 reconciliation)

Changed by this slice: the eight dialogs are no longer inspect-only (`Q017`, `Q018`, `Q060`, `Q064`, `Q083`, `Q084`, `Q109`:
the ids are accepted as extras and as locations, `panda.dialog.protected` lists only the two exceptions, admission and the
browser coverage specs expect a band in the eight).

Kept, with the non-security reason:

| Refusal | Reason it stays |
|---|---|
| `github-behind` as extra, location or accessory; `UnsupportedCapability` on admission | Recovery must work when a package is what is broken (fault isolation). |
| `extension-form` as extra or accessory | Isolation between owners: one package's form is not another's surface. |
| A manifest naming one of the eight without `ui.presentation` | The permission is the named grant of ADR-0005, listed at install; it is not a per-action prompt. |
| Stale, closed or replaced dialog; a foreign mount, project or task handle | The captured context is the predictable one; nothing retargets to whatever is current. |
| Fields `credentials`, `token`, `apiKey`, `path`, `prompt` in dialog and control contracts (`Q018`, `Q088`, `Q089`, `Q113`, `Q114`) | ADR-0006: credential values never reach a package, and a path or a prompt is not a presentation. |
| Primary action, confirmation, Escape and initial focus of every dialog | They are the host's own; the band never sits in a form (predictability). |
