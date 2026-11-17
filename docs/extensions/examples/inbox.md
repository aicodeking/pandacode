# Example: the Attention inbox (late answers, model tools and navigation)

Task R1210. One installable package, `sample.inbox` (`examples/extensions/inbox/`), the reference example of
[pending requests](../runtime-pending-requests.md) (R0507) and [late responses](../runtime-late-responses.md) (R0508): a trusted
background service that lists what waits for the user and can answer it after the hook budget. It also uses
[model tools](../runtime-model-tools.md), [hook context](../runtime-hook-context.md), the [rich channel](../runtime-rich-channel.md),
[notifications](../runtime-notifications.md) and [navigation](../runtime-dialog-navigation.md) (`panda.ui.reveal`).

## What the package does

| Part | What it shows |
|---|---|
| Waiting on you | A row per open approval (tool, short input, age), per open question, per `inbox_ask` and per failed turn. A row leaves when the host says the request ended (`approval.resolved`, `question.resolved`, whoever ended it), when the user marks an ask or failure handled, or when the model calls `inbox_resolve`. |
| Late answer | Approve, Deny and Answer send the panel's wish to the service, which calls `panda.tasks.respond`. The host's transcript says the request was answered through Attention inbox. |
| Stale, resolved, racing | One answer wins. When the user (or another package) answered first, the host answers `StaleContext` or `NotFound`: the row leaves and the panel shows the code. The service never retries, so an answer can never reach another request. |
| Mode and grants | A task mode or sandbox that holds an approve answers `UnsupportedCapability`; a missing or revoked `harness.hooks.decide` answers `PermissionDenied`. The row stays and the host's own prompt is untouched: the inbox never bypasses the mode. Deny is always possible. |
| Gaps | Hook deliveries are one-way. The service rebuilds the host's open set with `panda.hooks.pending()` at start, on every `task.idle`, after an event `gap`, and when a panel opens; its own rows (asks, failures) are kept and a resolved request never comes back. |
| Messages | `inbox_notify {message, url?}` adds an unread message labelled with the calling task; messages older than the retention setting are removed; Reply queues text into that task through `panda.tasks.message` (the host labels it). |
| Brief | With "Brief agents" on, the first `prompt.submit` of each task returns a short `context` block that the host labels with the package name. |
| Notification | A row older than the configured delay while the app is not focused raises one notice (never more than one per row). |
| Badge | The status item shows waiting rows plus unread messages; the counts per project travel in the snapshot. |
| Containment | A panel message the service does not know changes nothing; a service error never blocks an agent; disable, revoke and safe mode remove the hooks, tools, rows and badge and the host prompts stay normal. |

Limits: a notice has no click action in the contract, so "clicking it opens the inbox" is not wired (the status badge opens it);
task titles are task ids because no title is handed to hooks; a question answer is a text per question, secret questions are
left to the user (ADR-0006) and a harness question with no structured form (`q0`) is answered in the window.

## Evidence

Fake backends only; every column is **prepared, not run (deferred to the final test phase)**. Nothing here is an observation.

- Preview/Node: `tests/extensions-example-inbox.spec.ts` (grep `inbox example:`; Chromium port 16691, WebKit 16692) runs
  the shipped `main.cjs` against a stand-in of the service SDK with a fake host that keeps the open set and one winner.
- Native: the R0507 and R0508 native tests cover the events, the snapshot and the late answer.
- Installed Windows and the columns above: `tests/fixtures/extensions/example-inbox/evidence-columns.json` (R0306 runner,
  B5 scripted agent); pending until it is run.
