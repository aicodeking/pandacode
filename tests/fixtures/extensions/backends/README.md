# Extension runtime test back ends (staged)

Standalone, test-owned programs for PLAN-examples B1–B6. Use Node **v26.1.0**;
there is no install or build step and no dependency on PandaCode. Each helper
has its own folder and README. Move this entire `backends/` folder to the final
fixture location without changing any import. Only relative imports are used.

| Helper | Entry point | Role |
|---|---|---|
| B1 | `fake-daemon/fake-daemon.mjs` | TCP signals, issue tracker and machine metrics; HTTP controls |
| B2 | `fake-cli/fake-cli.mjs` | Thin, finite JSON command-line client of B1 |
| B3 | `fake-cloud/fake-cloud.mjs` | Separate identity/API listeners, PKCE, SSE and usage |
| B4 | `fake-browser/fake-browser.mjs` | Finite loopback HTTP redirect follower; no browser UI |
| B5 | `fake-agent/fake-agent.mjs` | Stdio ACP v1 fake, shared scripted scenarios, HTTP tool client |
| B6 | `make-sqlite/make-sqlite.mjs` | Finite SQLite fixture maker using `node:sqlite` |

`core/` contains the browser-importable state/interpretation logic: no Node
imports. Node transports, filesystem access, timers, S256 and random canary
tokens live in the wrappers. The cloud core takes an injected S256 function;
the scenario core takes injected emit/permission/question/tool/clock operations.

## Start, drive, stop

Spawn a helper with `process.execPath` and an **argument array**, `shell: false`,
`windowsHide: true`, and `stdio: ['pipe', 'pipe', 'pipe']`. Keep stdin open while
using it; close stdin and await the child `close` event at the end. See
`test-support.mjs` for a complete Node implementation. No helper spawns a child.

B1/B3 bind **only** `127.0.0.1`, port **0**, and print one JSON ready line on
stdout. Nonzero server port arguments are rejected. B5 prints its ready line
on **stderr**, keeping stdout exclusively ACP JSON-RPC. Read the ready line,
then use its returned addresses; never reserve or assume a port.

The three long-lived helpers accept `POST /control/shutdown`, exit on stdin
EOF, and handle termination. Their HTTP controls use fresh connections
(`Connection: close`), so a fault cannot leave a stale control connection in
the client's HTTP pool. All have `POST /control/reset`, `GET /control/log`,
`POST /control/fault`. Logs include HTTP headers/body and received TCP/ACP
frames in order. The log request includes itself. Reset clears the log and
state; it preserves existing transport subscriptions, and restores B1's seed.

Faults are `drop`, `stall`, `garbage`, `refuse`, with optional `ms`. Without
`ms`, reset or another fault is required. Dropped/refused requests are not
replayed. Controls remain usable. B1 drops data sockets, B3 drops existing HTTP
connections except the current control request, B5 drop stops the fake agent.
B3 refuse closes a data request's socket; B5 refuse returns a JSON-RPC error.

Finite B2/B4/B6 do not open control listeners or print an additional ready line:
B2 stdout must be one JSON result, B4 is silent, B6 prints one file result.
B2/B4 cancel pending asynchronous work when stdin closes; B6 closes its file
and exits after its bounded synchronous generation. Termination also ends them.

All requests and redirects are numeric loopback. Fixtures use only `tok-`
canaries. Deliberately raw fixture logs may contain these fake credentials;
they are the oracle for later **product** redaction tests. Never supply a real
credential to a helper.

## Tests

From this directory, on Windows PowerShell:

```powershell
$files = @(Get-ChildItem -Path */*.test.mjs | ForEach-Object FullName)
node --test --test-concurrency=1 --test-timeout=20000 --test-reporter=tap @files
```

Or run any helper's own `*.test.mjs` with `node --test`. These are the helpers'
tests, not product suites. Tests spawn only these Node fixtures, allocate free
loopback ports, and await their exact child processes. Cleanup fails the test
if an EOF stop requires its emergency child-specific kill. No installed
harness, system browser, external service, shell command tool, or product runs.

`evidence/` retains canonical generated SQLite files, the seed, received ACP
frames, browser URL log and the final TAP output. These are fixture/evidence
artifacts; there are no temporary copies, worktrees or package installations.
Database generation restores the fixture's own rows, including after edits.

## Scope and remaining integration

The receipt in `_work/10-docs/extension-runtime-receipt.md`, under **Test back
ends (staged)**, maps every helper to examples and records all specification
choices. Later work must wire package-provider/preview interpreters to the
shared scenario core, inject these helpers' free addresses, provide the browser
opener seam, transport hook reasons/rewrites, and qualify the actual host UI,
permissions, supervision and cancellation. None of those product behaviours is
established by these tests. ACP questions and compaction deliberately fail
with `UnsupportedCapability`; the scenario core supports both for transports
that can implement them. The HTTP MCP client supports JSON responses from the
current product server, not stdio or SSE MCP transports.
