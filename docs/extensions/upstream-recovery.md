# Crash restart and quit, for extension authors

Upstream sync P6 (S0608). After a crash PandaCode may restart itself and shows one notice (what happened, when, which
thread was kept closed, a crash report button); quitting asks first while agents run. This page records how an extension
adds to those two moments with the primitives that already exist, and what stays the user's. With no extension
installed, all disabled, uninstalled or in safe mode, the notice, Settings → General → Crash recovery and the quit
question are exactly upstream 0.3.128's.

## Parity with upstream (no lost drafts, no restore loop)

`src/crash-recovery.ts`, `src/crash-recovery-model.ts`, `src/crash-restart-settings.ts`, `src/launch-restore.ts`,
`src/preview-crash.ts` and `src-tauri/src/crash_guard/` were identical to the upstream merge parent (`e249e50`) at the
start of this task; `launch-restore.ts` and the crash guard are still unchanged, so draft keeping, the kept-closed
thread and the guard's "restart once, then pause" policy are upstream's. The additions are small and local: the notice
text and buttons take extension notes after upstream's own text, and the Settings group takes one block that exists only
while a note exists. No code path reads or writes a draft, the restart switch or a report. A package's read failing,
slow or malformed only drops that package's note; it never delays the notice and never triggers a restart.

## What a package contributes

Everything is an existing contribution; there is no new contract and no new permission.

| To change | Declare | Notes |
|---|---|---|
| A line in the crash notice | `contributes.settings` page `<owner>/crash-recovery`, `"section": "general"`, with a `show` switch and a `note` text | The note is shown as `From <name>: <note>`, cut at 160 characters, plain text only. The values live in the package's own settings namespace; the user edits them in Settings → General (explicit Save). |
| A button in the crash notice | `contributes.commands` entry `<owner>/checklist` | One quiet button, `<name> checklist`. It runs the package's declared command through the same path as Go to anything, which rechecks the owner when it is pressed. |
| What the quit question names | `runtime.service` and `lifetime.setStatus({ text, working })` | The package's working service is named by the one native account (`src-tauri/src/quit_guard.rs`, fed by `runtime_service_status::quit_packages`). See [runtime-service-status.md](runtime-service-status.md). |

`tests/fixtures/extensions/upstream-recovery/manifest.json` is the canonical example (permissions `ui.contribute`,
`runtime.service`; the service half is `main.cjs` next to it). To pack it as a ZIP, store the manifest as
`extension.json` beside `main.cjs`.

At most three notes are shown. The notice never shows more than a short line per package, and the order is the
discovery order unless the user changed it.

## What the user controls

Settings → General → Crash recovery gets a block, only while at least one note exists:

- **Hide / Show again** per note, **Move up / Move down**, **Restore all notes**. They are native buttons in Tab order;
  after a change, focus stays on the same control. The arrangement is a local UI preference
  (`pandacode.crashRecovery.extras.v1`), never a package value, and survives reload. Move buttons are
  `aria-disabled` at the ends of the list.
- The sentence `Quitting now asks first. Extension still working: …`, read from the same `quit` list the native account
  produces. It is a mirror: this module has no counter, no dialog and no way to ask or skip the question.

## Stale actions and cleanup

The checklist button is built from a capture of the lifecycle generation, the package's identity (its record,
including enablement and permissions), safe mode and the user's arrangement. A press after any of those changed is
refused and nothing runs: `Revoked` (the notice replaced or ended it), `WrongOwner`, `StaleContext` or
`Hidden`; a request id runs once (`AlreadyApplied`). A refused press only rewrites the notice. Disable, uninstall, losing
trust and safe mode remove the note and the button at once and restore upstream's text; re-enabling brings them back.
A revoked `runtime.service` grant stops the service, so nothing is named on quit; the note, which needs only
`ui.contribute`, is unaffected.

## Upstream members and who owns them

`RECOVERY_REGISTRY` in `src/extensions/upstream-recovery.ts` lists every member. A `protected` member keeps only
fault isolation, predictability, stability or irreversibility (ADR-0005); the rest are adapters. Handoff rows go to
S07C and are consumed by R1212.

| Member | Disposition | By |
|---|---|---|
| `crash-notice-text` | adapter | the labelled note |
| `crash-notice-actions` | adapter | the `checklist` command button |
| `crash-notice-arrangement` | adapter | Hide, Show again, Move, Restore all notes |
| `quit-confirmation` | adapter | service status through the one native quit account |
| `crash-restart-decision` | protected | the user's switch; decided before any package runs and a package that caused a crash must not decide it. Handoff **R0106** (supervised service restart policy: what a package may restart is its own service) |
| `crash-report` | protected | a report can hold paths, work text and credentials (ADR-0006); it is only revealed in the file manager |
| `unsent-drafts` | protected | the prompt content is the user's and Clear is irreversible. Handoff **R0403** (drafts through the task contract) |
| `window-reload-notice` | protected | it runs before extensions load, so no package could contribute to it |
| `safe-mode` | protected | recovery dialogs stay built in |

None of these is a permanent safety-only refusal: a capability needing a new runtime ability is a named handoff to the
runtime phase that owns it, never an exception waiting for a decision.

## Evidence

Reported separately; none substitutes for another.

| Column | What | Status |
|---|---|---|
| Preview (Chromium and WebKit) | `tests/upstream-recovery-extensions.spec.ts` (CI ports 16081/16082): zero extension, install → trust → enable → grant, labelled note and checklist, save and fault fallback, hide/reorder/restore with keyboard focus, stale and replayed requests, disable, uninstall, revoke, safe mode, the quit sentence next to the native account, and the restart switch and drafts controls with notes present. The preview runs no package code. | Written; run in the final test phase |
| Native authority and lifecycle | `runtime_service_status::tests` and `quit_guard::tests` (R0107: counting, naming once, wording; the installed fixture `runtime-service-status`), and the crash guard's own tests, unchanged by this task | Existing, run by R0107 and the final phase |
| Installed WebView | The crash notice with a real installed package on Windows/WebView2 (and macOS/Linux) | Pending; needs an installed build and a package launched after a forced crash. Not claimed |

Known inherited failures this task does not change (S04B): `crash-recovery.test.mjs` 186, 460 and 472 (notice length
and wording boundary assertions, source and test identical to upstream's pin) and `crash-recovery-restore` 27/64/85
(`New task ⌘ N` label on a Windows host). The ledger records this task's exception for the crash guard
(`discoveryLimits`) and cites this page and the spec.
