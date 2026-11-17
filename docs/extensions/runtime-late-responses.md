# Answering open requests after the hook budget (runtime slice R0508)

Native owner: `src-tauri/src/extensions/runtime_late_responses.rs`. Preview twin: `src/extensions/runtime-late-responses.ts`.
Fixtures: `tests/fixtures/extensions/runtime-late-responses/` (`scenarios.json`, the shared script both sides replay;
`responder/`, the service package `sample.late-responder` named "Late responder"; all `synthetic`). Spec:
`tests/extensions-runtime-late-responses.spec.ts` (preview/Node column). Native: `runtime_late_responses::tests`.

A `tool.before` hook that needs more than its budget does not hold the call: the normal prompt appears (R0505/R0506)
and the request becomes a pending event (R0507). The package answers when it can:

```js
panda.hooks.on('approval.pending', async request => {
  const verdict = await review(request);                       // may take far longer than any hook budget
  await panda.tasks.respond(request.taskId, request.requestId, { approved: verdict.ok, reason: verdict.why });
});
panda.hooks.on('question.pending', async request => {
  await panda.tasks.respond(request.taskId, request.requestId, { answers: { db: 'Postgres', name: 'atlas' } });
});
```

`panda.tasks.respond(taskId, requestId, answer)` (service request `tasksRespond`, params exactly
`{ taskId, requestId, answer }`) resolves to `null`. Permission: `harness.hooks.decide`, for the request's project and
tool kind (a question is checked as kind `other`). Nothing expires: an answer is valid while the request is open,
however long after the hook budget.

## Answers

| Request | `answer` | Sent to the harness |
|---|---|---|
| Approval | `{ approved: boolean, reason?: string }` (reason: non-empty, at most 4,096 bytes) | The ordinary answer, with the reason and the package as `decidedBy` beside it (R0502); a deny's reason travels in the answer (`denyReason: answer`), as a live steer right after it (`steer`: Pi, omp, Codex, OpenCode, Devin), or not at all (`none`) |
| Question (`kind: questions`) | `{ answers: { [id]: text \| [text] } }`, every question or none (none skips them, as the window's cancel does) | `{ answers: { [id]: [text] } }`, exactly as the window's form sends it; the harness checks the options |
| Question (`kind: form`) | `{ answers: { [field]: value } }` | `{ action: 'accept', content: answers }`; the form's schema still applies |
| Question (`kind: url`) | `{ answers: { url: 'accept' \| 'decline' \| 'cancel' \| true \| false } }` | `{ action }` |
| Question with no structured form (`q0`) | refused `UnsupportedCapability` | nothing; the user answers it in the window |

A rewritten input is not accepted here (a rewrite is decided inside the `tool.before` chain, where the call is held).
`answers` is at most 64 entries and 32 KiB, the window's own limit.

## Checks, in order

1. The package holds `harness.hooks.decide` for some project, else `PermissionDenied` (path `harness.hooks.decide`).
2. The request is open in that task. An id this app issued that is no longer open (answered, withdrawn, its run ended,
   its task removed) or that is open in another task answers `StaleContext`; an id never seen answers `NotFound`.
   Ids carry their run (`<run>:<harness id>`), so an old id never reaches a newer request reusing the harness id.
3. The grant reaches the request's project and tool kind (narrowing included), else `PermissionDenied`.
4. An approval stays inside the user's mode and sandbox: approving is refused `UnsupportedCapability` (path
   `$.answer.approved`) where R0505's `can` withholds `approve` (in `plan` any call that is not a read, search or
   fetch; a Codex, DeepSeek or Muse request, which asks only to leave its sandbox; the Claude Code family in `full`; a
   request whose approval would grant a standing rule). Denying is always possible. The mode read is the task's
   current one.
5. The answer fits the request's family (an approval answer to a question is `InvalidShape`) and form.

## One winner

Whoever answers first wins, the user (window, bots, remote viewer) or a package. Every answer path claims the request
first; while one answer is in flight the other is refused (the package gets `StaleContext`, the user "being answered").
The package's attribution, the reason and `decidedBy` are set under the same approvals lock the window uses, after the
request is known to be pending there, and the grant is checked once more at that moment: a revoke, a narrowing or a
disabled package in between sends nothing and leaves nothing attributed. An answer the harness rejects (a question's
validation) leaves the request open and unattributed for the user. Once answered, every later answer is
`StaleContext`.

## Attribution

- `approval.resolved` / `question.resolved` say `by: { package }` and carry the approval's `reason` (R0507's
  `attribute`); a secret question's answer stays out of `question.resolved` (ADR-0006).
- The harness receives `decidedBy` where it reads one (package providers, declared ACP harnesses).
- The transcript says "`<tool>` approved through `<Package>`." / "`<tool>` denied through `<Package>`. `<reason>`" or
  "Question answered through `<Package>`.".
- Some harnesses report an answered request as withdrawn while the answer is applied (package providers emit
  `approval_cancelled` / `input_cancelled`). While an answer is in flight and sent, such a report is that answer, so the
  resolved event names who answered instead of `cancelled`. The user's own answers get the same correction.

## Where the app reports

| Place | What |
|---|---|
| `emit_coalesced` (`lib.rs`), before R0507's sink | remembers each issued request (family, question form, standing-rule flag); turns a withdrawal of an answer in flight into that answer |
| `respond_approval`, `respond_user_input` commands | the user's claim |
| `RunningAgent::respond_approval_with`, `respond_approval_for_extension`, `answer_user_input` (`lib.rs`) | the window's checks and lock, with the attribution step inside them |
| `runtime_service_lifetime` dispatch | `tasksRespond` |
| `node-host.cjs` | `panda.tasks.respond` |

A task on another machine is answered through the same `remote::route` path as the window's answer
(`approval.respond`, `input.respond`).

## Refusal-test reconciliation (Q rows naming this slice)

This slice delivers one permissioned operation, `panda.tasks.respond` under `harness.hooks.decide`, with positive,
missing-grant, revoked, disabled and stale probes in its spec and native tests. The listed rows assert that declared,
service-less paths cannot answer a request; none is an operation this slice delivers, so each is retained:

| Rows | Retained refusal | Non-security reason |
|---|---|---|
| Q001, Q046 (`respond_approval`, `respond_user_input` thread-action kinds) | the declared kinds do not validate | A manifest action has no request identity; `panda.tasks.respond` names the task and the request and checks it is open there (predictability) |
| Q013, Q079, Q105 (action dock `approve`, `deny`, `answer`) | refused / `InvalidArguments` | Same; stale, replayed, forged and foreign-worker ids keep their identity refusals, here `StaleContext` / `NotFound` |
| Q014 (roster `approve`, `answer`) | refused | Same |

## Columns and limits

- Preview/Node: the spec (both Playwright configurations, WebKit grep `extensions late responses:`, CI ports
  16601/16602): every shared scenario, parsing, answer shaping, admission against the grant narrowing and the mode,
  the claims, the responder service past its 2 s delay, and source checks of the wiring. Native fixtures:
  `runtime_late_responses::tests` (the same scenarios with a stand-in agent keeping the window's checks, a late deny
  claimed by the adapter with its reason and package on a paused clock). Installed service qualification with
  `sample.late-responder` and any real harness: pending, not claimed. No harness was run.
- A task on another machine receives the decision only: the reason and `decidedBy` are not carried by the remote route
  (the local resolved event and transcript line still name the package).
- The form of a mirrored task's question is inferred from its frozen questions (the request was not seen by this
  app's sink).
- A request id remembered as issued survives its task's removal (bounded: 256 per task, 8,192 in all), so a late
  answer for it is `StaleContext`; beyond the bound it is `NotFound`.
