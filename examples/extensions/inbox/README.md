# Attention inbox (experimental API 1, background service, hooks, model tools and a rich panel)

One place that lists what waits for the user: approvals and questions the host holds (they stay open past the hook budget
and are answerable later), the model's own `inbox_ask` rows, failed turns, and unread messages from `inbox_notify`. A
status item shows the count, "Go to task" takes the window to the task, and Approve, Deny and Answer go through
`panda.tasks.respond`, so the host still decides: a mode or sandbox that holds an approval, a request the user answered
first, or a revoked grant leaves the normal prompt where it was. Full guide: [the Attention inbox](../../../docs/extensions/examples/inbox.md).

```powershell
Compress-Archive -Path examples/extensions/inbox/package/* -DestinationPath $env:TEMP/sample.inbox.zip -Force
```

Install, accept executable trust, enable, then allow the permissions the install lists (`harness.hooks.observe` receives the
pending events, `harness.hooks.decide` lets a late answer reach the request, `tools.model` offers the three tools, `tasks.message`
sends a reply). `main.cjs` is the service; `panel/` is the page. Fake harnesses only in tests.
