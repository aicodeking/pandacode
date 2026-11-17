# Project memory (experimental API 1, model tool, recall at send, capture and a one-shot model call)

A trusted background service that remembers things per project: a public model tool `memory` (add, search, list, forget),
recall appended to the user's message at send (the first message of a task, or every message, and again after a
compaction), capture after a turn (a debounced `turn.finish` / `task.idle`, one `panda.models.call` for the summary,
`<private>` text dropped, near duplicates skipped) and a rich panel that lists, searches and deletes. Full guide:
[the project memory](../../../docs/extensions/examples/memory.md).

```powershell
Compress-Archive -Path examples/extensions/memory/package/* -DestinationPath $env:TEMP/sample.memory.zip -Force
```

Install, accept executable trust, enable, then allow the permissions the install lists (`runtime.service` starts the
service; `tools.model` lists the tool; `harness.hooks.context` lets recall reach the message; `harness.hooks.observe`
delivers the turn events; `models.call` asks for the summary; `tasks.transcript.read` and `tasks.tools.read` read the turn;
`storage.private` gives the data directory; `harnesses.inventory` tells the panel which harness takes no tool server;
`ui.richViews` mounts the panel). Settings → Extensions → Project memory sets recall (first or always), how many memories,
the capture wait and capture on or off. `lib/memory.mjs` is the whole logic; `main.cjs` only gives it a store file;
`panel/` is the page. Companions are pending (deferred by user decision 2026-11-17); the package says so.
