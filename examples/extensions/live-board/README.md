# Work board, cut A (experimental API 1, background service)

A trusted background service that reads a tracker daemon: a status item with the daemon's ready count, a table of the issues,
a **Retry tracker** header button while the daemon is away (the last snapshot stays, marked stale), and a **Who is working**
dialog whose answer the service keeps. Full guide: [the Work board](../../../docs/extensions/examples/live-board.md).

```powershell
Compress-Archive -Path examples/extensions/live-board/package/* -DestinationPath $env:TEMP/sample.live-board.zip -Force
node --test tests/extensions-examples.test.mjs
```

Install, accept executable trust, enable, then allow the five permissions the install lists (`runtime.service` starts the
service; `ui.dynamic` lets it update the status item and the table). Set the tracker address in Settings → Extensions → Tracker.
`lib/board.mjs` is the whole logic; `main.cjs` is only the TCP transport. For tests, the fake daemon of
`tests/fixtures/extensions/backends/` plays the tracker.
