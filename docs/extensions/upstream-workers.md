# Workers panel and Running agents dock after the upstream merge

Upstream sync P6 (S0605). PandaCode 0.3.128 changed how workers read (effort labels, Council reviewer rows, the tally,
the request text, approval labels) and gave the Running agents window a dismissable failure. This page records which of
those an installed package reaches through the public primitives that already exist, and which stay with the host.
With no extension installed, all disabled, or in safe mode, both surfaces behave exactly as upstream 0.3.128.

The adapter core is `src/extensions/upstream-workers.ts` (JSON only, no DOM). It adds no new contract, permission or IPC.

## What a package reaches

| Member | Primitive | Notes |
|---|---|---|
| Worker identity and selection | `panda.actionDock` `worker-open` / `team-open` / `team-toggle` | Captured window, context, project, task, team and revision; the handle is opaque and ordered as drawn. A stale, replayed, forged or foreign request is refused (`StaleContext`, `AlreadyApplied`, `InvalidArguments`) and the original handler runs once. |
| Worker status and the tally | `DockPresentation.workers` and `panda.team.actions` status/badge | Only with `tasks.summary`: a status word and an attention flag per worker, at most 64 rows, never a name, assignment, path or summary. |
| Hide, reorder, restore | `panda.team.controls`, `panda.actionDock.controls` | Original nodes move or hide; the Workers toggle never hides; hidden items keep their keyboard path. |
| Actions beside the Workers head | `panda.team.actions`, `panda.team.context` | Contributions only; focus returns to the head after a menu closes. |
| Actions in the Running agents window | `panda.agentsDock.actions` | Hide/reorder like other action slots; Collapse, Unpin, rows and recovery are `panda.agentsDock.protected`. |

## What stays with the host

| Member | Why |
|---|---|
| Effort label (`effortLabel`) | Host-rendered text. The effort actually applied is native state (`architect/model_efforts.rs`); a package never sets or reads it. Runtime handoff: R0404B (worker, council and limit controls). |
| Council reviewer row (`reviewerRow`) | Scores and verdicts are host council state. Handoff: R0404B. |
| Request text (`requestHtml`) | Assignment text is prompt content and never crosses the package boundary. |
| Approvals (`approvalLabel`, `worker_approvals*`) and Stop | Host authorization. No public control approves, denies, answers or stops a worker. |
| Dismissing a failure in the Running agents window | Host-owned, like the thread's grouped errors. |

Rows that need a new runtime ability are named handoffs (R0404B), consumed by the runtime phase; this adapter does not
claim those contracts delivered.

## The Running agents window failure

The window shows one failure at a time in its live region. Its capture is the thread's grouping key (`errorKey` in
`thread-errors.ts`) and a revision that moves whenever the shown text changes; the same failure again keeps its
capture and is not announced twice. A dismissal names that key and revision and a request id: another failure, an
already cleared one, a forged request or a replay does nothing. A pointer or keyboard Dismiss behaves exactly as upstream
(clears the failure and moves focus to the first row or Collapse). The window exposes `data-error-key` and
`data-error-revision` on `.agents-dock-window-error-row` while a failure shows.

## Evidence

| Claim | Evidence | Kind |
|---|---|---|
| Zero-extension baseline, install/enable, customization, stale refusal, hide/reorder/restore, keyboard and focus, permission without `tasks.summary`, fault fallback, disable, safe mode | `tests/upstream-workers-extensions.spec.ts` in Chromium and WebKit (`?extensions-baseline&upstream-workers&dock-coverage&replacement`) | Browser preview with the synthetic `architect-event` team |
| Projection, bounds, effort and status words, captured error dismissal | the same spec, adapter-core test | Browser module |
| The Running agents window failure | the same spec, last test (`/agents-dock.html`) | Browser preview |
| Fixture | `tests/fixtures/extensions/upstream-workers/manifest.json` | Manifest |
| Native authority and lifecycle (grants rechecked natively, package disable/uninstall on a real install) | existing native tests of the package registry and `windows.rs`; not repeated here | Native |
| Installed WebView (the pinned Running agents window on a real install) | pending the installed qualification pass (`runtime-platform-qualification.md`); the browser preview never substitutes for it | Installed |

Tests were written in the implementation phase and run in the final test phase.

Fixture package: `sample.upstream-workers` (permissions `ui.contribute`, `ui.customize`, `tasks.summary`).
