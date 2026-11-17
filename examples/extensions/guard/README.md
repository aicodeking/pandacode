# Command guard (experimental API 1, background service with tool hooks)

A trusted background service that judges the shell commands an agent is about to run. A `tool.before` hook reads the whole
command, sees through wrappers (`sudo`, `env`, `sh -c`, `powershell -Command`) to ten levels, splits pipes and chains, and
**denies** destructive ones (`git reset --hard`, `rm -rf` outside the project, a stash drop, a custom rule) with a reason and a
rule id the agent receives. It **rewrites** a plain `git push --force` to `--force-with-lease` where the harness can run new
arguments, and it never approves anything: with no decision the normal prompt appears. It has three levels, a settings page,
a project policy file that can raise the level but never lower it, a status item with the number of denials, a **Guard log**
table, **Explain a command**, and an audit file with secrets redacted. No panel is needed. Full guide:
[the Command guard](../../../docs/extensions/examples/guard.md).

```powershell
Compress-Archive -Path examples/extensions/guard/package/* -DestinationPath $env:TEMP/sample.guard.zip -Force
node --test tests/extensions-examples.test.mjs
```

Install, accept executable trust, enable, then allow the permissions the install lists (`runtime.service` starts the service;
`harness.hooks.observe` and `harness.hooks.decide` let it see and decide tool calls; `ui.presentation` lets its note and its
tool-row signals show; `storage.private` gives it the data directory of its audit file). `lib/analyzer.mjs` is the whole analysis
and `lib/guard.mjs` the service; `main.cjs` is only the files and the folders. For tests, the B5 scripted fake agent plays the
harness (`tests/fixtures/extensions/example-guard/scenarios.json`).
