# B5 stdio ACP fake agent

Spawn `node fake-agent.mjs` with stdin/stdout/stderr pipes. Stdout contains only
newline-delimited ACP v1 JSON-RPC. Read readiness from **stderr**:
`{ready:true,transport:"stdio-acp",control:"http://127.0.0.1:<free>"}`.
The maximum input line is 64 KiB. Set `FAKE_AGENT_LOG` to a fixture-owned file
to append **every received frame**, including responses, as JSONL. No tool input
is executed. No real harness, shell or external service is invoked.

Supported: `initialize`, `session/new {cwd,mcpServers}`, `session/prompt
{sessionId,prompt:[{type:"text",text}]}`, `session/cancel {sessionId}`.
Unknown sessions, concurrent prompts and unknown methods fail explicitly.
Completion has `stopReason:"end_turn"` or `"cancelled"`; scripted fail returns
a JSON-RPC error. No resume, fork, model or mode capabilities are advertised.

Prompt: `#script ` followed by a JSON array; otherwise `echo: <prompt>`.
`#reply <answer>` returns the fixed answer for one-shot model-call tests.
The shared `core/scenario.mjs` implements say, tool, question, listTools,
callTool, echoPrompt, usage, compact, sleep, fail. Each step has one action.
Tool announcements produce ACP tool_call/tool_call_update; `ask:true` emits
session/request_permission with allow/reject-once options and waits. Normal
ACP selected allow completes and echoes `ran: <JSON input>`; reject echoes an
explicit no-reason message if the protocol response supplied none.

**Fixture-only reason/rewrite seam:** put `{reason,input}` under the response's
`result._meta.fixture`. This is a test extension, not a product or ACP claim.
It lets tests prove the shared interpreter echoes `denied: <reason>` and
`ran: <rewritten input>`. Standard ACP does not transport those fields today.

ACP question and compact steps fail with `UnsupportedCapability`; ACP v1 has
no corresponding frame in the characterized transport. The shared interpreter
supports them through injected adapters. Usage emits `usage_update {used,size}`
with the original report in `_meta.fixtureUsage`; actual host normalization
still needs its runtime slice. echoPrompt echoes the entire received text.

Attached tool servers are ACP HTTP entries
`{type:"http",name,url,headers:[{name:"Authorization",value:"Bearer tok-..."}]}`;
object headers are also accepted. Only numeric HTTP loopback is accepted;
redirects are errors. The fake performs MCP initialize, initialized notification,
tools/list and tools/call over actual HTTP with those headers. It lists names
and echoes tool-result/tool-error/tool-missing. It supports JSON responses from
the current host server, not SSE or stdio MCP transports. Cancellation aborts
pending HTTP, sleep and permission work.

HTTP test controls: GET `/control/log`; POST `/control/reset`, `/control/fault
{kind:"drop"|"stall"|"garbage"|"refuse",ms?}`, `/control/shutdown`. Reset
cancels turns and clears sessions/log. Drop exits, stall ignores incoming frames
until recovery, garbage writes an invalid stdout line, refuse returns RPC errors.
Stop on control shutdown, stdin EOF or termination; await process close.

Examples: Work board (1) short turns; Attention inbox (3) permissions, tools,
failure/context (questions need another interpreter); Command guard (4)
checked/permissive tools and reason/rewrite seam; Project memory (5) actual tool
attachment, calls, context and fixed summary; Usage band (7) usage/context
(compaction needs another interpreter). The package-provider and preview twins,
product hook transport and actual UI are deliberately not edited in staging.

Test: `node --test fake-agent.test.mjs` (five tests).
