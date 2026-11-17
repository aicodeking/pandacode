# Usage band (experimental API 1, background service, composer band and rich panel)

A trusted background service that puts one band segment above the composer for the task in view: the context fill as a
percentage with a bar, and the tightest limit window (`5h: 63% left, resets 14:20`). The numbers are the host's own: the
`usage` resource per task, the `limits` and `accounts` resources per harness, and the answer of one declared connection
(the usage API, read with the credential the host holds, never by the package). **Start fresh** (two clicks) starts a new task
with a checkpoint, **Insert checkpoint** writes it into the composer draft without sending, **Clean up** compacts the task
where the harness can, and **Usage report** (a header button and the `/usage-report` slash command) opens a panel with tokens
per day and per harness and model. Full guide: [the usage band](../../../docs/extensions/examples/usage.md).

```powershell
Compress-Archive -Path examples/extensions/usage/package/* -DestinationPath $env:TEMP/sample.usage.zip -Force
node --test tests/extensions-examples.test.mjs
```

Install, accept executable trust, enable, then allow the eighteen permissions the install lists. Each part has its own grant:
without `ui.presentation` there is no band, without `tasks.draft` Insert checkpoint says it could not write, without
`tasks.control` Clean up says it did not run, and so on; nothing else of the package stops. Set how often the API is read
(and when the limits notice appears) in Settings → Extensions → Usage band. `lib/usage.mjs` is the whole logic; `main.cjs` only
keeps the daily ledger in the package's data folder; `panel/` is the report page. For tests, B3 (the fake cloud) plays the usage
API on port 19474 (`--api-port 19474`) and B5 (the scripted harness) emits the `usage` steps.
