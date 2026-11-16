# B1 fake daemon

Start `node fake-daemon.mjs [--port 0] [--control-port 0] [--seed seed.json]`
with piped stdin kept open. Read stdout's single
`{"ready":true,"socket":"127.0.0.1:<free>","control":"http://127.0.0.1:<free>"}`.
Nonzero ports are rejected. `startDaemon()` also exports a factory with
`state`, `ready`, `close()` and `done`; its import starts no server.

Send UTF-8 TCP NDJSON, at most 65,536 bytes per line excluding LF. Example:
`{"id":1,"op":"issues.get","params":{"id":"T-1"}}`. The outer `id` is the
request id; target ids belong in `params` (or use flat `issueId`). Answers are
`{id,ok:true,result}` or `{id,ok:false,error:{code,message}}`. Malformed or
oversized input receives `InvalidFrame` and ends that connection.
An oversized non-snapshot response returns `FrameTooLarge`; snapshots use the
chunk protocol. Ordinary valid output lines also obey the 64 KiB bound.

Operations: `hello`, `subscribe {topic,intervalMs?}`, `ack {signal}`;
`issues.snapshot`, `issues.chunk {transfer,index}`, `issues.get {id}`,
`issues.create {title,type?,priority?,description?}`,
`issues.update {id,patch,ifRevision?}`, `issues.claim {id,actor}`,
`issues.close {id,reason?}`, `issues.reopen {id,ifRevision?}`,
`deps.add/remove {id,dependsOn}`, `comments.add {id,text}`;
`metrics.machines`, `metrics.history {machine,sinceMs}`. `sinceMs` is an
inclusive absolute epoch-millisecond lower bound. A conflicting revision
returns `Conflict`, without changing the issue.

Subscriptions: `signals` pushes `signal`; `issues` pushes `issues.changed`;
`metrics` pushes `metrics.sample` and `metrics.machine`. Each frame is
`{event,seq,data}`. Sequence is global. A metrics subscription's interval
(100–60,000 ms) can be changed by subscribing again. History keeps 30 minutes.
At the fastest due subscription a scripted sample advances once per machine;
only subscribers due at that tick receive it. CPU/memory values persist after
a script ends. Offline machines do not sample and retain their last seen data.

Ready issues are open with no unresolved dependency. Blocked means explicit
blocked status or an unresolved/missing dependency, excluding closed issues.
Claim means in progress. Every mutation increments the global revision and
uses it for the changed issue. A seed is `{issues:[...],machines:[...]}`;
reset restores it. No initial replay occurs on subscription: request a snapshot.

Snapshots below 60,000 serialized UTF-8 bytes are inline. Larger ones return
`{chunks,transfer}`. Fetch every zero-based chunk; each returns
`{transfer,index,text}`. Concatenate **text**, then JSON-parse the complete
snapshot. Code-point chunks stay below the line cap even with JSON escaping.

POST JSON to `/control/signal {name,payload}`, `/control/issues
{op:"add"|"update"|"remove",issue}`, `/control/issues/fill {count}` (replace
with 0–10,000 generated issues), `/control/machine {id,name?,online}`,
`/control/metrics {machine,cpu,mem}`, `/control/metrics/script
{machine,samples:[{cpu,mem}]}`, `/control/fault {kind,ms?}`,
`/control/reset`, `/control/shutdown`. GET `/control/log` returns ordered TCP
requests, close events and HTTP requests with headers. Faults: drop existing
data sockets; stall ignores data requests; garbage pushes an invalid line;
refuse drops existing and new sockets until recovery. Controls stay available.

Stop by POST shutdown, stdin EOF, or termination, and await process close.
Signals serve R2; issues/chunks/revisions and B2 serve Work board (1);
metric scripts/history/offline events serve Machine monitor (2). Host panels,
retry logic, notifications and permissions are later product integration.

Test: `node --test fake-daemon.test.mjs` (five tests).
