# Example: Project memory (a model tool, context at send, capture and a one-shot model call)

Task R1207. One installable package, `sample.memory` (`examples/extensions/memory/`), the reference example of the harness-side
runtime phases: a model tool served by a service ([model tools](../runtime-model-tools.md)), context appended to the user's message
([prompt context](../runtime-hook-context.md)), observers that read a finished turn ([hook registration](../runtime-hook-registration.md),
[content reads](../runtime-content-resources.md)) and one bounded model answer ([model call](../runtime-model-call.md)).

## What the package does

| Part | What it shows |
|---|---|
| Model tool `memory` | Modes `add {content}`, `search {query, limit?, scope?}`, `list {limit?}`, `forget {id}`; the answer is always the envelope `{ content, isError? }`. Memories are per project (the call's `projectId`); `scope: "all-projects"` also searches the others. `approval: "never"`, declared at install. |
| Recall at send | A `prompt.submit` hook returns `{ context }` with up to three (setting, 1 to 10) memories of the project, ordered by shared words with the message. The host appends them under `Extension context from Project memory (not written by the user):` and the thread folds them into one collapsed block. With `first` (the default) recall runs on the first message of a task and on the turn after a compaction (`sinceCompaction` is 0); with `always` on every message. No hit adds nothing. |
| Capture | `turn.finish` and `task.idle` share one debounce per task (10 s by default, 200 ms in tests). The service reads the turn with `panda.context.query` (`transcript`, `tools`), builds one prompt (the user's text, the answer, shortened tool calls), asks `panda.models.call` for a summary with the package's own system text and stores it with tags. One turn is captured once. |
| Privacy | Text inside `<private>…</private>` (an unclosed tag cuts to the end) is never stored and never sent to the model. A turn that is all private stores nothing and calls nothing; an `add` of it answers `Private content blocked`. |
| Duplicates | A capture whose word overlap (Jaccard) with a memory of the project is 0.9 or more is not stored again. |
| Panel | One rich view (inspector): the memories of the current project, a search box, Delete, and plain statements of what is not available: the tool state, `tool unavailable for <harness>` for each harness whose `panda.harnesses.list` row has no tool-server path, recall and capture state, and the compaction line. |
| Data | `memories.json` in the package data directory (`panda.storage.directory`, permission `storage.private`), rewritten atomically: it survives a service restart and an update, and is removed only by "remove own data". A real package would keep SQLite and embeddings there; the scorer here is deterministic so tests are exact. |
| Settings | Page `sample.memory/settings`: `inject` (`first` or `always`), `count`, `debounce` (milliseconds) and `capture` (`on` or `off`); a save re-reads the page (`settings.changed`). |

## Permissions and what happens without each

`ui.contribute`, `runtime.service`, `events.workspace`, `tools.model`, `harness.hooks.context`, `harness.hooks.observe`, `models.call`,
`tasks.transcript.read`, `tasks.tools.read`, `ui.richViews`, `storage.private`, `harnesses.inventory`. Nothing decides: there is no
`harness.hooks.decide`, so the package never rewrites a prompt, blocks a send or shapes a compaction.

- Without `tools.model` the tool is not listed (the panel says `inactive (PermissionDenied)`); recall and capture still work.
- Without `harness.hooks.context` the host reports the context part as refused (a receipt); the panel says recall is inactive and why.
- Without `models.call`, or while the app has no hidden-run path (the answer is `UnsupportedCapability`, explicit and never a hang), capture
  stores the turn text shortened to 600 characters, marked `raw`, with a visible note in the panel. No model answer is invented.
- Without the transcript read the panel names it and nothing is captured.

## Compaction and companions

Recall comes back on the turn after a compaction through `sinceCompaction`, which needs no companion. Whether a companion could shape a
harness's own compaction is **pending: companions deferred, user decision 2026-11-17** (the R06 line was skipped). The package states it in
the panel and the status, claims nothing more, and returns no `summary`, `instructions` or `cancel` from any hook. A harness that takes no
tool server (`panda.harnesses.list`: `toolServers.value` false) gets no `memory` tool; recall at send, which the host owns, still works there.
The ZCode bridge for package tools is a pending decision of the model-tool slice.

## Evidence

Preview evidence, not native: `tests/extensions-example-memory.spec.ts` (grep `memory example:`; Chromium port 16661, WebKit 16662) runs the shipped
`main.cjs` and `lib/memory.mjs` in the test runner's Node against a stand-in of the service SDK: a scripted transcript and tool rows
(`tests/fixtures/extensions/example-memory/turns.json`), a scripted `panda.models.call` that answers like B5's `#reply` form, and a real
temporary data directory. It covers the scorer, privacy filter and deduplication, the four tool modes, recall on the first message, not the
second, after a compaction and with `always`, capture with one model call, the debounce shared by two hooks, private-only and duplicate turns,
capture without `models.call`, lost grants as named states, the panel (list, search, delete, harness notes), persistence across a restart and
an update, and a stop that leaves nothing behind. No real model, harness or sign-in is used.

Native column (B5 `fake-agent.mjs` over stdio ACP with `listTools`, `callTool`, `echoPrompt` and `#reply`: the tool listed and called, the
context block echoed, capture end to end, the stopped-service error result, and `UnsupportedCapability` from the unwired hidden run) and the
installed-Windows column (the R0306 runner) are listed in `tests/fixtures/extensions/example-memory/evidence-columns.json`.

All of it is **prepared, not run (deferred to the final test phase)**; nothing in this guide is an observation. The receipt keeps the preview,
native, installed and companion columns apart; the companion column stays pending.

## Limits

- The hidden-run path of `models.call` is not wired in the app yet: until it is, capture stores raw text with a note.
- The turn read serves the display preview of tool calls, so tool arguments in a memory are short by construction.
- `turn.finish` carries no usage yet, and the first message of a task is told apart by the package (a task id it has not seen), so a service
  restart recalls once more on the next message of a task already running.
