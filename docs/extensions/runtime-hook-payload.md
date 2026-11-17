# Complete tool inputs and approval answers (runtime slice R0502)

Native owner: `src-tauri/src/extensions/runtime_hook_payload.rs`. Preview twin: `src/extensions/runtime-hook-payload.ts`.
Fixtures: `tests/fixtures/extensions/runtime-hook-payload/` (`answers.json`, `scenarios.json`, both `synthetic`).
Spec: `tests/extensions-runtime-hook-payload.spec.ts` (preview/Node column). Native: `runtime_hook_payload::tests`
(pure) and `runtime_hook_payload::tests::windows_transport` (feature `extension-runtime-native-tests`, Windows: the
B5 fake agent through `runtime_provider_launch::drive`).

This slice gives the hook path (registration and delivery are R0503, decisions R0505) two things it needs from the
harness side: the **complete** input of every call, separate from the display preview, and an answer that can carry a
**reason**, a **rewritten input** and the **deciding package** back to the harness.

## Complete input, separate from the display preview

`ToolActivity.input` stays a preview for the interface (4,096 bytes in built-in protocols, 2,000 characters in a
declared ACP harness). Each adapter hands the complete input value of the harness frame to
`runtime_hook_payload::record(run, project, harnessCallId, input)` before its preview is cut:

| Source | Where the complete input comes from |
|---|---|
| Built-in permission requests (`Protocol::approval`) | `frame_call`: Claude Code `request.input`, ACP `params.toolCall.rawInput`, PandaCode-served tools `params.arguments`, Codex `params`, ZCode `params.input` |
| Built-in ACP tool updates (`kimi_tool`), Claude Code `tool_use` blocks | `rawInput` / `input` of the frame |
| Declared ACP harness (`runtime_provider_launch`) | `rawInput` of `tool_call` / `tool_call_update`, passed to core as `inputJson` beside the bounded tool event |
| Package handler provider | `ProviderEvent` of kind `tool` with `inputJson` (the complete input; the tool's `input` stays the preview) |

Built-in runs record only while `runtime_hook_payload::observed()` is on (the hook registration slice turns it on
while an enabled package holds a hook); off, a built-in run does exactly what it did before. Package provider runs
always record. A declared ACP harness frame may now be up to 8 MiB (it was 1 MiB), so an input over 1 MiB reaches
the host at all.

The host issues its own `callId` (`call-<uuid>`) per run and harness call id, because harness ids repeat across runs
(Codex uses small integers). The same `callId` pairs the permission request (`requestId`) with its call.

### Payload fields

`HookCall` carries `inputBytes` (UTF-8 bytes of the compact JSON serialization) and either:

- `inputComplete: true` and `input`, structured, when the serialization is at most 1 MiB **and** the value leaves
  room for the envelope in the hook frame budget (depth 64, 131,072 nodes); or
- `inputComplete: false` and `inputPreview`: the first 1 MiB of the serialization, cut back to a code point
  boundary, and cut further when writing it as a JSON string would push the frame over 2 MiB (a serialization full
  of backslashes or quotes doubles when escaped). The preview is text, never a JSON value.

`hook_call(base, callId)` adds `schemaVersion`, `callId` and these fields to the dispatcher's `HookCallBase` facts and
checks the whole frame (`frame_check`: 2 MiB, depth 64, 131,072 nodes, envelope included).

### `panda.hooks.input`

`serve({ callId, cursor })` (strict: exactly those two fields) answers
`{ schemaVersion: 1, text, cursor, nextCursor, totalBytes }`. `cursor` is a UTF-8 byte offset into the one
serialization; any offset on a code point boundary up to `totalBytes` is valid (0 starts at the beginning, the
preview's byte length continues after it), any other is `InvalidShape`. Each `text` holds at most 256 KiB cut back to
a code point boundary; `nextCursor` is `null` after the last chunk; the concatenated texts parse as the complete
input. A chunk result is at most about 512 KiB once escaped, well inside the 2 MiB frame. The caller checks
`harness.hooks.observe` for the call's project (`scope(callId)` gives the run and project) before serving.

### Lifetime

The serialization is fixed once a payload was built (`payload`, `hook_call`), a chunk was read or a hook holds the
call; until then a later frame of the same call replaces it (a harness that streams its arguments). The adapter calls
`finish(run, harnessCallId)` when the call completes, fails, is denied or cancelled; the text is dropped once no hook
holds it (`retain` / `release` around a chain and its `tool.after`). Afterwards a read answers `StaleContext`; an
unknown or evicted call answers `NotFound`. Bounds: 256 calls and 64 MiB per run, 4,096 calls and 256 MiB over all
runs; the oldest unheld calls go first (ended ones first), a held call is never dropped. `forget_run` drops a run's
calls and requests when the run ends (wired through `providers::forget_decline_reasons`, which every run end already
calls).

## Answers: reason, rewritten input, deciding package

`RunInput::Approval { request_id, approved }` keeps its exact shape everywhere (about thirty answer paths, the remote
route and the bots use it). The extra details travel beside it, like `providers::set_decline_reason`:

1. The adapter opens the request with the call it asks about and what its source can carry:
   `open_approval(run, requestId, harnessCallId, Support)`.
2. The answering side (a hook decision, `panda.tasks.respond`) attaches
   `Answer { approved, reason?, input?, decidedBy? }` with `attach(run, requestId, answer)`, then sends the ordinary
   `RunInput::Approval`.
3. The adapter claims it once with `take(run, requestId, approved)` and renders it for its protocol. Details that
   disagree with the decision actually sent are dropped; a user's own answer reads exactly as before.

`attach` answers `StaleContext` when the request is not open in this run, and **`UnsupportedCapability` when the
answer rewrites the input of a source that cannot run new arguments**: nothing is attached, the request stays open,
the normal prompt stays, and the old input is never approved in the new input's place.

### What each source carries (`Support`)

| Source | Deny reason (`denyReason`) | Rewritten input |
|---|---|---|
| Claude Code, GLM, MiMo, Alibaba (Claude stream protocol) | `answer`: control response `message` | yes: `updatedInput` |
| Pi, omp, Codex, OpenCode, Devin | `steer`: the answering side sends a live steer right after the answer | no |
| Other built-in ACP harnesses, ZCode, Muse | `none` | no |
| Package handler provider | `answer`: `ProviderInput.reason` | only when its `approval` event lists `"rewriteInput"` in `can` |
| Declared ACP harness | `answer` when it declares `agentCapabilities._meta.pandacode.permissionAnswer.reason` | when it declares `...permissionAnswer.updatedInput` |

`Support::can()` gives `HookCall.can` for a call that came with a permission request
(`approve`, `deny`, `ask`, plus `rewriteInput` where supported); `Support::json()` gives
`{ denyReason, rewriteInput }` for `panda.harnesses.list`.

### Renderings

- Package handler provider (`ProviderInput`): `{ kind: 'approval', approved, reason?, input?, decidedBy? }`
  (`provider_input`). A declared ACP harness receives the same value from core and reads it back with `answer_of`.
- ACP permission result: the selected option as before, plus `_meta.pandacode = { reason?, updatedInput?, decidedBy? }`
  with only the fields the agent declared it reads (`acp_permission_result`). `_meta` is ACP's extension point; an
  agent that declared nothing gets the bare decision, byte for byte as before.
- Claude Code: `{ behavior: 'allow', updatedInput: <rewritten or original> }` or
  `{ behavior: 'deny', message: <reason or the host's own decline text> }` (`claude_permission_response`).

### Questions

A structured question over ACP (a permission request whose options are answers, `q<N>_opt_<M>` or several allow
options) is no longer declined as cancelled by a declared ACP harness: `acp_question` turns it into core's `questions`
list (one question, the allow options as answers), core shows it as an ordinary `input_request`, and
`acp_question_result` selects the option whose label was answered (anything else cancels). `open_question` /
`attach_question` / `take_question` carry the deciding package of a question's answer. The normalized events:

- `approval_resolved(taskId, requestId, callId?, answer?)`:
  `{ requestId, callId?, taskId, approved, reason?, by: 'user' | 'cancelled' | { package } }`;
- `question_pending(...)`: `PendingQuestion` from core's normalized `input_request` data;
- `question_resolved(taskId, requestId, decidedBy?, answers?)`: `{ requestId, taskId, by, answers? }`.

## Fake agent

`tests/fixtures/extensions/backends/fake-agent/` (B5) gains, by short edits: `FAKE_AGENT_PANDACODE=reason,updatedInput`
declares the PandaCode answer fields and makes the agent read `_meta.pandacode`; `padInput: N` on a tool step pads its
input so a small prompt emits a tool frame of any size. Without the variable the agent is a standard ACP agent.

## Evidence columns

- Preview/Node: the spec (twin against both fixtures, the fake agent over real stdio).
- Native fixtures: `runtime_hook_payload::tests` and `windows_transport`; the built-in rendering parity test in
  `builtin_protocol.rs`.
- Installed/live qualification: not claimed. No real harness was run; the Claude hook-callback capture gate of R0501
  stays pending.

## Limits

- `steer` routes (Pi, omp, Codex, OpenCode, Devin) are reported, not sent: sending the steer after a deny belongs to
  the answering side (R0505). The Pi bridge channel does not carry the reason yet.
- Built-in tool arms record the complete input for the ACP family and Claude Code `tool_use` blocks; other built-in
  arms (Codex items, Pi, ZCode activity) record it at their permission request only.
- Questions answered by a package need the answering side (`panda.tasks.respond`, R0505); this slice carries the
  attribution.

## Refusals (ADR-0005)

No capability is withheld from a trusted package. Retained refusals have non-security reasons: `UnsupportedCapability`
for a rewrite the harness cannot run (the harness would run the old input: predictability), `StaleContext` for a
request that is no longer open and for a call that ended (identity), `InvalidShape` for a cursor inside a code point
or an unknown field (predictability), `LimitExceeded` for a reason over 4,096 bytes or a rewritten input over 1 MiB
(frame budget).
