# Example: the usage band (per-task usage, account and limits, a task-scoped composer band)

Task R1208. One installable package, `sample.usage` (`examples/extensions/usage/`), the reference example of the composer band
([composer band](../runtime-composer-band.md)), the usage resources ([usage resources](../runtime-usage-resources.md)), declared
connections ([connection adapters](../runtime-connection-adapters.md)), drafts ([drafts](../runtime-tasks-drafts.md)) and harness
hooks ([hook context](../runtime-hook-context.md)). It combines them into the usage band the plan names in `PLAN-examples.md`
(example 7).

## What the package does

| Part | What it shows |
|---|---|
| Band segment | One segment per task, registered with `panda.ui.register({ kind: 'menu', location: 'panda.composer.band', scope: { taskId } })`. Text `Context 74% \| 5h: 63% left, resets 14:20`, a bar with the fill, a tone by threshold (under 50 success, 50 to 70 info, 70 to 80 warning, above danger; a window at 20% left or less is at least warning, at 5% danger). It shows only while its task is in view; a task with no report shows `No usage yet` and no bar. The manifest's placeholder segment is hidden, so the package has one segment. |
| Where the numbers come from | `usage` (the last report of each turn, `tasks.usage.read`), `limits` and `accounts` (`harnesses.limits.read`, `harnesses.accounts.read`): the row of the harness's **active** account is the one shown. Nothing is parsed from a display string. A running task is read again every 500 ms, so the band follows a report within a second; a turn end, a task switch, the window gaining focus and the interval read again too. |
| The usage API | Every `min-interval-seconds` (default 300) the service reads `GET /v1/usage` through the declared connection `sample.usage/api` (header authentication `x-api-key`, a fixed `x-client` header, the `json` adapter). The credential is the host's: the service only passes the opaque handle `connections.status` gives it. None is read while no task exists. Its windows join the host's and are named `api 5h`. |
| Stale and offline | A stale reading of the host is marked `(stale)`. When the API does not answer the last values stay, marked stale, and the tooltip says so; a signed-out API says it needs its credential in Settings. Neither stops the band. |
| Account changes | The `accounts` resource carries the active flag; the next read (focus, turn end, task switch, interval) shows the new account's windows and names its label in the tooltip. Never an e-mail, plan or token. |
| Context nearly full | Crossing 80% raises one notice per task and crossing (`Context nearly full`); it is armed again when a compaction brings the fill under 80. |
| After a reply | The setting `after-reply` (off, low, always) raises a `Usage limits` notice listing each window with its percentage and reset time; `low` means the tightest window is at 20% left or less. |
| Context note | The `prompt.submit` hook returns `context is 74% full; keep output brief` (the host shows it as labelled context) when the fill is above 70%, at most once per five minutes and three times per task. |
| Buttons | **Start fresh**: the first click only arms the button (its label changes and it disarms after 8 s), the second starts a task in the same project with the checkpoint as its prompt (`tasks.start`, labelled with the package). **Insert checkpoint** writes the same text into the draft (`tasks.draft.insert`), never sends it. **Clean up** (`tasks.compact`, `tasks.control`) is offered only where `panda.harnesses.list` says the harness compacts. |
| Usage report | A header button and the `/usage-report` slash command open a rich panel: tokens per day (a canvas bar chart) and per harness and model, for today, 7 and 30 days, from the ledger the service records at each `turn.finish` hook (one row per task and turn, kept 400 days in the package's data folder). The figure is the context tokens the harness reported at the end of the turn. |

## How it is built

- `package/lib/usage.mjs`: all the logic, one browser-safe ES module (no imports, no Node). `package/main.cjs`: the installed
  entry; it only supplies the ledger file in `storage.directory`. The browser preview runs the same module.
- `package/panel/`: the report page. It draws what `report.data` carries and asks for a fresh copy; it reads nothing else.
- Permissions (eighteen): `ui.contribute`, `runtime.service`, `events.workspace`, `ui.dynamic`, `ui.notify`, `ui.presentation`,
  `ui.richViews`, `tasks.usage.read`, `harnesses.limits.read`, `harnesses.accounts.read`, `tasks.summary`, `storage.private`,
  `connections.request`, `harness.hooks.observe`, `harness.hooks.context`, `tasks.start`, `tasks.draft`, `tasks.control`. No
  `credentials.*` and no `secrets.private`: the package holds no credential and no secret of its own ([ADR-0006](../../agent-reference.md#extensions)).
- Revoking a grant removes only its part and is rechecked natively on every call: the band without `ui.presentation` (the host
  strips it), the buttons without their grants, the numbers without the read grants (`Usage unavailable`). Disable, safe mode and
  stop remove the band, the hooks and the subscriptions; the composer, the draft and a running task are untouched.

## Evidence

Preview evidence, not native: `tests/extensions-example-usage.spec.ts` (Chromium port 16671, WebKit 16672) runs `lib/usage.mjs`
in the preview runner against the preview twins of the usage resources, live items and notices, with B3's browser-importable
core as the usage API. The connection, the hooks, the draft, compact, the harness list and the report panel's channel are
stand-ins written in the spec and labelled so, and the band's own permission gate is a stand-in too. Scripted turns, a limit
reset, a changed account, a stale reading, an offline API, every threshold and every stop reason are covered
(`tests/fixtures/extensions/example-usage/scenario.json` holds the figures; the credential canary must not appear in any layer,
notice, post or fault). It never proves the installed package.

Native and installed evidence are **prepared, not run (deferred to the final test phase)**
(`tests/fixtures/extensions/example-usage/evidence-columns.json`): B3 with `--api-port 19474` and B5 `usage` steps against the real
resources and hook path, then the installed Windows run of the band layout at the minimum width, the report panel and the account
switch. Nothing in this guide is an observation. The receipt keeps preview, native and installed apart.

## Limits

- The ledger records the context tokens at each turn end, not tokens spent: the host's usage event has no input or output split.
- No event announces a usage report; a running task is polled (500 ms), an idle one is read at the events above.
- Reset times use the local time zone of the window.
- The API's address is fixed in the manifest (a connection's address is manifest data); the example uses the B3 loopback port.
