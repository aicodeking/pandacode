# Work board, cuts A, B and C (experimental API 1, background service, rich panel and attributed task start)

A trusted background service that reads a tracker daemon: a status item with the daemon's ready count, a table of the issues,
a **Retry tracker** header button while the daemon is away (the last snapshot stays, marked stale), a **Who is working**
dialog whose answer the service keeps, and (cut B) a rich panel with the board, selection, detail and Claim, Close and Undo
through the tracker's command-line tool, and (cut C) **Start**: mark issues, choose project, harness, mode and worktree, preview
the exact prompt, confirm, and the host starts one task labelled with the package (`tasks.start`); the marked issues then say
Agent finished when the turn ends. Full guide: [the Work board](../../../docs/extensions/examples/live-board.md).

```powershell
Compress-Archive -Path examples/extensions/live-board/package/* -DestinationPath $env:TEMP/sample.live-board.zip -Force
node --test tests/extensions-examples.test.mjs
```

Install, accept executable trust, enable, then allow the seven permissions the install lists (`runtime.service` starts the
service; `ui.dynamic` lets it update the status item and the table; `ui.richViews` mounts the panel; `tasks.start` lets Start
create the task). Set the tracker address in
Settings → Extensions → Tracker. `lib/board.mjs` is the whole logic; `main.cjs` is only the TCP transport and the command-line
runner; `panel/` is the page. For tests, the fake daemon (B1) plays the tracker and `PANDA_FIXTURE_B2` names the fake tool (B2).
