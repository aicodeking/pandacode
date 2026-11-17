# Replaceable, attributed notifications

Slice R0207. A trusted package with `runtime.service` and the `ui.notify` grant can raise a notice, replace it and
withdraw it while its service runs. Every notice names the package that raised it, in the in-app list and in the
operating-system channel alike, so a notice is never anonymous. Nothing here reads or sends anything on its own: a
notice is only what the service asks for.

## What a package sees

```js
exports.service = async (panda, lifetime) => {
  await panda.ui.notify({ key: 'build', title: 'Builds', text: '3 builds failed', tone: 'danger' });
  await panda.ui.notify({ key: 'build', title: 'Builds', text: '4 builds failed', tone: 'danger' });   // replaces it
  await panda.ui.withdraw('build');                                                                    // removes it
};
```

| Call | Does |
|---|---|
| `panda.ui.notify({key, text, title?, tone?})` | Raises the notice named `key` of this package, or replaces it when it is live. Answers `{key, replaced, merged, os}`. |
| `panda.ui.withdraw(key)` | Removes the notice. A key that is gone (or never was) answers `NotFound`, however often it is used. |

- `key` is 1 to 128 characters without control characters, chosen by the package; the host never reads it as an
  identity of another package. `text` is 1 to 1,024 characters (line breaks kept); `title` up to 120; `tone` is
  `neutral` (default), `info`, `success`, `warning` or `danger`. Another field answers `InvalidShape`, an oversize one
  `LimitExceeded`.
- A notice has no action, no link and no button of its own: it is read, and dismissed by the user. A package-run action
  stays a command in a contribution (`panda.ui.register`).
- The package's display name leads every row; the title, when it differs, follows it. The text shown on hover is
  bounded like the app toast's (`toastTitle`, 500 characters).

## Surfaces and the recorder

- **In-app list** (`src/extensions/runtime-notifications.ts`, `[data-extension-notices]`): a glass list above the app
  toast (`src/extensions/runtime-notifications.css`, the same `--glass-*` tokens, solid fallbacks for reduced
  transparency, increased contrast and forced colors). A replaced key changes its own row in place (the node and focus
  stay); a withdrawn or dismissed notice leaves. Each row has a **Dismiss** button; the user is never forced to wait.
  The tone `danger` is marked; the app toast itself (`toast-model.ts`) is not used or changed: it stays the host's.
- **Operating-system channel** (`OsChannel` in `runtime_notifications.rs`): `show` and `withdraw` per notice, named with
  the package. **This build has no operating-system channel**, so the app's channel answers `unavailable` for every
  operation. That state is reported (`os: "unavailable"` in the answer, the snapshot and the recorder), never shown as
  delivered, and never blocks the request or the in-app notice. A channel that delivers answers `delivered`.
- **Native recorder** (`extensions_runtime_notice_recorder`, read only, the last 256): the ordered operations that reached
  the surfaces, `show`, `replace`, `merge`, `withdraw`, `dismiss`, each with the package, key, title, text, tone, what
  the OS channel answered and, for a withdrawal the host made, its `reason` (`evicted`, `service-stopped`,
  `revoked-or-disabled`, `safe-mode`). Tests compare it with the visible list: after `withdraw` the key is gone from both.

## Limits (for predictability, never for trust)

- **Six sends per package per minute.** The next sends in the window merge into one notice of the package, "N more
  notices from <package>", whose count grows in place; no other notice is created or replaced. The merged notice stays
  until the user dismisses it or the service stops; the window slides, so a minute after the first sends the package
  raises notices normally again. Another package has its own window.
- **32 live notices per package.** A new one past that withdraws the oldest (`reason: evicted`).
- Withdraws and the user's Dismiss are not counted.

## Authority and cleanup

The grant is checked natively on every request against the grants file (`runtime_grants`), so a revoke, a narrowing, a
stale version or an untrusted package answers `PermissionDenied`. Notices are removed from both surfaces, with the
withdrawal recorded, when:

- the user revokes `ui.notify` (the grant command sweeps at once, no service restart needed);
- the package is disabled or removed, or safe mode starts (the sweep and the stopping service);
- the service stops for any reason (disable, uninstall, update, trust loss, crash): the ended hook clears its notices.

With no package, every package disabled and in safe mode, nothing is raised and nothing is drawn: the list is not even
created in a preview window. Package notices do not reach the thread-errors toast (`docs/extensions/upstream-errors.md`):
a host failure stays visible and a package never suppresses or replaces it.

## Refusals kept, and why (ADR-0005)

Reconciliation of Q015, Q081 and Q107: the existing assertions refuse the **webview status component's** actions
(`toast-undo`, `toast-action`, `progress-clear`, `update-restart`, usage polling and sign-in) and the fields of its
presentation. None of those is the operation this slice delivers (`panda.ui.notify` and `withdraw` raise a *new* notice
from a service; they do not act on the host's toast), so no existing assertion changes and the rows are split by
operation: `ui.notify` and `ui.withdraw` are asserted to succeed with the grant
(`tests/extensions-runtime-notifications.spec.ts`, `runtime_notifications::tests`). The refusals retained keep a
non-security reason:

| Refusal | Reason |
|---|---|
| No grant, revoked, stale version, untrusted (`PermissionDenied`) | the grant is the user's decision; nothing runs without it |
| Disabled package, safe mode (`NotFound`) | nothing runs for a package the user turned off |
| Webview status actions for the toast's Undo, action buttons, Clear, restart | host-owned reversible flows; the package asks for its own notice instead |
| Bad key, text, title, tone, unknown field (`InvalidShape`) | input validation |
| Text over 1,024 or title over 120 characters (`LimitExceeded`) | stability of the list |
| Withdraw of a gone key (`NotFound`) | a handle that is gone is never a second success |

## Evidence

- Native: `runtime_notifications::tests` (replacement, merge window, cap, refusals, sweep and dismiss) and the installed
  service test `runtime_service_lifetime::tests::installed::notifications_*`, driven by the canonical B1 fake daemon
  (fixture `tests/fixtures/extensions/runtime-notifications/`). Written; run in the final test phase.
- Browser preview: `tests/extensions-runtime-notifications.spec.ts` runs the same model and the row plan in Chromium and
  WebKit. A preview window has no service, so its list is empty.
- Installed WebView qualification and a real operating-system channel are separate and not claimed.
