# Pending approvals and questions as durable events (runtime slice R0507)

Native owner: `src-tauri/src/extensions/runtime_pending_requests.rs`. Preview twin:
`src/extensions/runtime-pending-requests.ts`. Fixtures: `tests/fixtures/extensions/runtime-pending-requests/`
(`scenarios.json`, the shared script both sides replay; `inbox/`, the observer package `sample.pending-inbox`; all
`synthetic`). Spec: `tests/extensions-runtime-pending-requests.spec.ts` (preview/Node column). Native:
`runtime_pending_requests::tests`.

A hook handler that needs more than its budget does not hold the call. It returns nothing (or `ask`), the normal prompt
appears, and the request becomes an event. This slice delivers the four events R0503 already lets a package register:

```js
panda.hooks.on('approval.pending', request => inbox.add(request));     // PendingApproval
panda.hooks.on('approval.resolved', ended => inbox.remove(ended));      // { requestId, callId?, taskId, approved, reason?, by }
panda.hooks.on('question.pending', request => inbox.add(request));      // PendingQuestion
panda.hooks.on('question.resolved', ended => inbox.remove(ended));      // { requestId, taskId, by, answers? }
const { approvals, questions } = await panda.hooks.pending();          // the current open set, after any gap
```

All four are observe only (`observeOnly: true`): nothing waits for them, a handler's return is never read. Receiving
them needs `harness.hooks.observe` for the request's project; the declaration's `match.harnesses` and `match.runs`
filter them like every hook (`toolKinds` and `extensions` are refused on these events by R0503's check).

## Identity

A request is keyed by its task and the id the app shows it under: `<run>:<harness id>`, the id the window, the bots,
the remote route and `respond_approval` use. Harness ids repeat across runs (Codex uses small integers), so two runs of
one task never share an identity.

- A **duplicate or resumed frame** of an open request (the same id again, a mirror's card sync after a lost frame)
  opens nothing.
- A request that **ended** is remembered (256 per task, 8,192 in all) and never opens again, so a late frame cannot
  replay a resolved question.
- The fields are **frozen** when the request opens: the task's mode at that moment, the tool, the complete input as
  `tool.before` saw it. A later frame or a later mode change never edits them.
- Bounds: 64 open requests per task and 4,096 in all; beyond them the oldest is no longer tracked (and never reopens).

## Payloads

`approval.pending` (`PendingApproval`):

| Field | Value |
|---|---|
| `requestId`, `taskId`, `projectId`, `harness`, `mode` | the identity and the run's facts (`mode` is the task's mode when the prompt appeared) |
| `callId` | the host call id of `tool.before` / `tool.after` (R0502), when the adapter recorded the call |
| `tool` | `{ kind, name }`: the name from the event's data or the prompt's `Allow <tool>?` line, the kind from R0503's table, then the input's fields |
| `text` | the prompt as shown, cut to 64 KiB |
| `input` | the complete input when it travels structured (at most 1 MiB, as in `HookCall`) |
| `askedBy` | `{ package }` when a package's `ask`, or a package that did not answer under `onFailure: "ask"`, put the prompt there (R0505/R0506); `mode` when a run launched ask-at-host still shows a prompt (a standing-rule or always-ask request); `harness` otherwise |
| `at` | RFC 3339, when the prompt appeared |

`question.pending` (`PendingQuestion`): `{ requestId, taskId, projectId, harness, questions, at }`. `questions` comes
from core's normalized `input_request`:

| Data | Questions |
|---|---|
| `kind: "questions"` | each as asked: `id`, `question`, `header` and option `description` only when not empty, `multiple: false`, `secret` from `isSecret` |
| `kind: "form"` | one per schema property, by name: `question` is the title, else the description, else the name; `header` the form's message; `options` its `enum`; `multiple` for an array; `secret` for `format: "password"` |
| `kind: "url"` | one question `url` holding the message and the address |
| anything else | one question `q0` holding the prompt's text |

`approval.resolved`: `{ requestId, callId?, taskId, approved, reason?, by }`. `question.resolved`:
`{ requestId, taskId, by, answers? }`, where `answers` is core's `{ [id]: { answers } }` for a `questions` request,
without the answers of secret questions (ADR-0006: a value the user typed as secret for the harness is never handed to
a package). A form's or a link's answer is not carried.

## Who ended it (`by`)

Every pending request gets exactly one resolved event:

| `by` | When |
|---|---|
| `user` | Answered from the window, a bot conversation or a remote viewer (`respond_approval` / `respond_user_input`, including the routed path of a task on another machine) |
| `{ package }` | Answered through a package: R0508 attributes the answer (`attribute`) before sending it; the event carries its `reason` |
| `mode` | (approvals) The harness withdrew the request after the task's mode changed (for example Claude Code cancels a pending `can_use_tool` once the new mode allows the call) |
| `cancelled` | Withdrawn by the harness otherwise (cancelled, timed out, the account switched), its run ended (requests of that run only, by the id prefix), its mirrored turn ended, or its task was removed |

A request the host answers itself never waits for the user and so is never pending: a package's approve or deny
(R0505), ask-at-host answering as `full` would, a team worker's automatic decision.

## No time limit

Nothing in the book expires. A prompt that a timed-out `tool.before` hook left in front of the user (30 s per hook,
60 s per chain) stays pending, listed and frozen until one of the endings above. This is what lets an inbox answer
later (`panda.tasks.respond`, R0508).

## Recovering after a gap: `panda.hooks.pending()`

Deliveries are one-way and can be lost: a service that is restarting, parked or has 64 calls pending costs the event
(R0503), and the node host keeps at most 256 waiting deliveries. `panda.hooks.pending()` (service request
`hooksPending`, params `{}`, strict) answers the current open set:

```ts
{ schemaVersion: 1, revision: number, approvals: PendingApproval[], questions: PendingQuestion[], truncated: boolean }
```

- In the order the requests opened, with the same frozen payloads the events carried.
- Filtered exactly like a live delivery, checked now: approvals only for a package that attached `approval.pending` or
  `approval.resolved`, questions only for one that attached `question.pending` or `question.resolved` (neither:
  `UnknownReference`), each request only where that hook's `match` accepts its run and the package holds
  `harness.hooks.observe` for its project.
- A resolved request is never in it, so rebuilding a list from it never replays one. `revision` only grows (every
  open, end or drop counts).
- Within the 2 MiB hook frame: over budget, an approval's `input` is left out first (read it with `hooks.input` while
  the call is live), then whole requests, with `truncated: true`.

The inbox fixture rebuilds from it when it starts, whenever a task goes idle, and on request.

## Where the app reports

| Place | What |
|---|---|
| `emit_coalesced` (`lib.rs`) | `approval` / `input_request` open, `approval_cancelled` / `input_cancelled` withdraw (ids already carry the run prefix) |
| `respond_approval`, `respond_user_input` commands | answered by the user, after the agent accepted it, also on the routed path |
| the run's end (`lib.rs`, after `runtime_hook_registration::run_ended`) | the run's open requests end `cancelled` |
| `delete_session` | the task's open requests end `cancelled`, then nothing of it is kept |
| `runtime_harness_coverage::mirror_events` / `mirror_ended` | a mirrored task's requests (run kind `remote`) |
| `runtime_hook_decisions` (R0505), the `ask` prompt | `askedBy: { package }` |
| `runtime_hook_registration::turn_ended` | `task.idle.pending` counts what was still open when the turn ended (each then ends `cancelled`) |

The book records requests whether or not a hook is attached (a few fields per open prompt), so a package that attaches
later still finds what is waiting; deliveries cost nothing while no hook is attached.

## Refusal-test reconciliation (Q rows owned here)

This slice delivers observe-only events and the `hooks.pending` read, under `harness.hooks.observe`. It delivers no
answering operation (that is R0508's `panda.tasks.respond`, under `harness.hooks.decide`). None of the listed
assertions is an operation this slice delivers, so none is changed; each is retained:

| Rows | Retained refusal | Non-security reason |
|---|---|---|
| Q001, Q046 (`respond_approval`, `respond_user_input` thread-action kinds) | the declared kinds do not validate | A manifest action has no request identity; observing requests is a hook (this slice) and answering one is `panda.tasks.respond` (R0508), which checks the request is open in that task. A second, declarative path would answer without identity (predictability) |
| Q013, Q079, Q105 (action dock `approve`, `deny`, `answer`; `respond_approval` never called) | refused / `InvalidArguments` | Same; the stale, replayed, forged and foreign-worker refusals are identity checks (a resolved id never reopens here either) |
| Q014 (roster `approve`, `answer`) | refused | Same |

## Columns and limits

- Preview/Node: the spec (both Playwright configurations, WebKit grep `extensions pending requests:`, CI ports
  16561/16562): every shared scenario, delivery against the grant and `match`, the timed-out-hook prompt, the inbox
  service across a lost-event gap, the frame budget, and source checks of the app's wiring. Native fixtures:
  `runtime_pending_requests::tests` (the same scenarios, the endings, the bounds, the frame budget, delivery and
  snapshot against a stand-in registry, the timed-out prompt on a paused clock). Installed service qualification with
  `sample.pending-inbox` and any real harness: pending, not claimed. No harness was run.
- A request's facts come from the hook registry when a hook observes the run (its run kind), else from the store (run
  kind `task`, or `remote` for a mirrored task).
- `question.resolved` has no `mode` (the contract's question endings are `user`, `{ package }`, `cancelled`).
- `panda.harnesses.list`'s per-path `delivered` list still names R0503's events only (R0509's report; the register
  answer says `delivered: true` for these four).
- Team worker requests are resolved by the team at once and never show as pending.
