# Tool rows and result cards after the upstream merge

Upstream sync P6 (S0603). PandaCode 0.3.128 reworked how a tool call reads in the transcript: a one-line sentence per
call (`Ran [git] status`), a result card under the disclosure, a folded group summary (`Read 2 files`), thumbnails of
the images a call names or wrote, and quiet or failed rows. This page records what the extension build lets a package
do with those rows and cards, what stays host-owned, and which fixture and evidence prove it. With no package
installed, all disabled, or in safe mode, every row and card draws exactly as upstream 0.3.128.

## What upstream draws (unchanged)

`src/tool-activity.ts` renders each call as a `details.tool-activity.tool-trace` (or a plain line when there is
nothing to open) carrying `data-tool-key`, `data-tool-status`, `data-tool-kind`, `data-tool-name`, optional
`data-tool-family` and the states `data-tool-failed`, `data-tool-blocked`, `data-tool-interrupted` and
`data-tool-quiet`. The sentence comes from the twelve `tool-trace-*.ts` modules plus `tool-fields.ts`,
`tool-names.ts` and `tool-text.ts`; the destructive-command badge and its risks, the `exit N` and `then failed`
badges, failure blame, refusal rows (`Blocked: …`, `Interrupted: …`) and the shell-intent classifier decide what a row
says and are never customized. Group summaries (`tool-trace-summary.ts`) and the thumbnails (`tool-images.ts`) are
host presentation too.

## What a package can do

A package places controls on a row and on its result card. Both use the existing action location
`panda.thread.trace.actions` (the same one the turn card uses), so no new location, permission, schema location or
native command exists:

| Part | Where the host marker sits | `context.selection.kind` |
|---|---|---|
| Tool row | the end of the row's summary line, before the chevron | `tool-row` |
| Result card | the end of the disclosed body, after the card | `tool-card` |

`context.selection.ids` is `[<tool call key>, <tool name>, <tool kind>, <MCP server>]`; the server is present only for a
call named `mcp__server__tool` or `Server · tool`. The context also carries the captured `sessionId` and `projectId`.
Never the call's input, output, a path, a command line or a thumbnail.

A package opts in by a menu at `panda.thread.trace.actions` whose `visible` condition names one of the two kinds
(`{ "op": "eq", "key": "selection.kind", "value": "tool-row" }`). A package that only decorates the turn card
(no condition on a tool kind) never makes the host place a marker on every tool row. A contribution without any
`selection.kind` condition does appear in every marker once some other package asked for them: write the condition.

Order, hiding and restoring work as for every action location: Settings → Extensions → Surface explorer, location
`panda.thread.trace.actions`, **Hide**/**Show** and **Move … before/after**; the user's choice persists and applies to
every row and card. Hidden controls are `hidden` and keep their node.

The `ui.contribute` permission registers the menu; `ui.customize` lets the user select a layout proposal. Both are the
ordinary grants from the install dialog. The action runs the declared command (a message or a dialog); it never sends,
edits, retries, stops or deletes a tool call, and package code never reads the row.

## Captured context and stale actions

The marker carries an `identity` made of the part, the call key, name, kind, status and the failed/blocked/interrupted/
quiet states. When a call's outcome changes under an open row (running → completed, a failure reported later) the
identity changes, the old marker and its controls are removed and a fresh one is mounted against the new outcome, so
an action captured for the earlier outcome can never be replayed on the later one. An unchanged row keeps its mounted
controls and keyboard focus through every redraw. A removed row takes its marker with it; if focus was inside a
replaced marker it returns to the row's own summary.

## Keyboard and focus

Contributed buttons are reachable by Tab after the row's summary and run on Enter or Space. A press on a contributed
button never opens or closes the row around it; Space or Enter on the summary itself still does.

## Lifecycle, faults and safe mode

- Disable or uninstall removes every marker and control at once; the rows' own markup is unchanged.
- Safe mode (**Disable extensions for this launch**) removes the markers and controls and keeps the upstream rows.
- Disabling extension layouts withdraws only the layout proposals; the hide/order preferences stay.
- A fault while placing a row's marker removes only that row's markers; the renderer, the other rows and the composer
  go on. A failing package command shows its own error and never blocks the transcript.

## Exceptions recorded in the ledger

These upstream members have no extension path, by design of their owner, and are exceptions with provenance, not
closures (`tests/fixtures/extensions/surfaces.json`):

- **Shell intent classification** (`src/shell-intent*.ts`, `tool-trace-intent.ts`, `tool_images_auth/shell.rs`): it is
  how PandaCode decides what a command does, and the destructive and failed signals depend on it. A package cannot
  replace or tune it.
- **Destructive/risk badges, failure blame and refusal rows**: drawn from that classification; a package neither hides
  nor rewrites them.
- **Tool image thumbnails and the image viewer**: the thumbnail is part of the row; opening, copying and revealing an
  image belong to S0604.

## Named handoffs (new runtime abilities)

These capabilities are not delivered by this adapter. They need runtime abilities owned by later phases, and are
named handoffs (rows for the S07C handoff list, consumed by R1212), not refusals:

| Capability | Owning phase |
|---|---|
| Rows and cards attributed to a package's own model tools or tool servers (`tools.model`), with the package's name on the row | R10xx (model tools and tool servers) |
| A package that observes, denies, approves or rewrites a tool call before it runs, and a row that says so | R0502–R0506 (hook payload and decisions) |
| Replacing a row's sentence or card, and showing a package-supplied risk | R1004 (replacement and risk) |

A sync adapter's acceptance of the existing contract does not claim those later contracts delivered.

## Fixture and evidence

- Fixture: `tests/fixtures/extensions/upstream-tool-rows/manifest.json` (package `sample.upstream-tool-rows`: two row
  actions and one card action at `panda.thread.trace.actions`). The browser preview installs it with `?upstream-tool-rows`
  through the real Install local package and Enable flow.
- Browser preview (Chromium and WebKit): `tests/upstream-tool-rows-extensions.spec.ts` — zero-extension rows, install
  and enable, captured context, stale outcome, keyboard, hide/reorder/restore, disable, fault, safe mode and uninstall.
  Seeded tool rows only; no real harness runs.
- Native authority and lifecycle: the grants, install and enable authority, safe mode on disk and uninstall are the
  existing native fixtures of the extension platform (`src-tauri/src/extensions`); this adapter adds no native
  command. They are reported separately.
- Installed WebView qualification: pending; browser preview is not installed acceptance.
