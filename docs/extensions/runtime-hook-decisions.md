# Tool decisions: approve, deny, ask, rewrite, and scoped full mode (runtime slice R0505)

Native owner: `src-tauri/src/extensions/runtime_hook_decisions.rs`. Preview twin: `src/extensions/runtime-hook-decisions.ts`.
Fixtures: `tests/fixtures/extensions/runtime-hook-decisions/` (`extension.json` + `main.cjs`, the guard package
`sample.hook-guard` named "Guard"; `decisions.json`, the scripted returns both folds read; `modes.json`, the per-call
`can`, coverage and launch table; `scenarios.json`, the demonstration; all `synthetic`). Spec:
`tests/extensions-runtime-hook-decisions.spec.ts` (preview/Node column). Native: `runtime_hook_decisions::tests`.

R0503 delivers `tool.before` one way, R0504 awaits the chains of `prompt.submit`, host-tool `tool.after` and
`compaction`. This slice makes `tool.before` a decision the host applies:

```js
panda.hooks.on('tool.before', async call => {
  if (call.input?.command?.includes('rm -rf')) return { decision: 'deny', reason: 'rm -rf outside the project' };
  if (call.tool.kind === 'read') return { decision: 'approve' };
  if (call.input?.command?.startsWith('curl ')) return { decision: 'ask', reason: 'network access' };
  if (call.can.includes('rewriteInput') && call.input?.command?.startsWith('npm ')) return { decision: 'rewrite', input: { ...call.input, command: `pnpm ${call.input.command.slice(4)}` } };
});
```

## Who is asked

A `tool.before` occurrence reaches every attached hook whose `match` filter and `harness.hooks.observe` grant accept
it (R0503). Among them, the packages that hold `harness.hooks.decide` for the call's project **and tool kind** (the
grant's narrowing, checked natively per call) are **deciders**: they are asked one after another (registration order;
R0506 adds the user's order), each inside its declaration's `budgetMs`, the whole chain inside 60 s, with the frame
`{ schemaVersion: 1, hookId, event: 'tool.before', observeOnly: false, payload }`. The other packages receive the call
one way (`observeOnly: true`, `can: []`), as before. With no decider the request takes exactly the path it took before
this slice. Node host: handlers of hooks run inside `hookScope`, so a call a handler makes (for example
`panda.tasks.setMode`) is marked as coming from a hook (R0404).

The payload is R0503's `HookCall` with:

| Field | Value |
|---|---|
| `source` | `permissionRequest` (a request as it arrives), `askAtHost` (full launched ask-at-host); `companion` is R06xx |
| `coverage` | the harness capability table's (`runtime_harness_coverage::request_coverage`): `askedCalls` or `escalationsOnly`; never `everyCall` for a request |
| `can` | computed per call, see below |
| `input` | as the earlier deciders rewrote it (`inputComplete: true`, `inputBytes` of the rewrite) |

## `can`: the source, the mode and the sandbox

`can` starts from what the source carries (R0502's `Support`: `approve`, `deny`, `ask`, plus `rewriteInput` where the
harness runs new arguments). Then, natively:

- ask-at-host never offers `rewriteInput`;
- `approve` and `rewriteInput` are removed where the task's mode or sandbox holds the call: in `plan`, any call that
  is not a read, search or fetch; a request of Codex, DeepSeek or Muse (they ask only to leave their sandbox); the
  Claude Code family in `full` (it asks only for what no mode approves); a request whose approval would grant a
  standing rule (`lastingOnly`).

A package decides inside the user's mode and sandbox, never around them: such a call can be denied or sent to the
user, not approved by a package (receipt `UnsupportedCapability`; the normal prompt appears).

## Resolution (`DecisionFold`)

| Return | Effect |
|---|---|
| `{ decision: 'deny', reason }` (reason required, 4,096 bytes) | Ends the chain and wins |
| `{ decision: 'ask', reason? }` | Wins over any approve; the first ask's reason is shown |
| `{ decision: 'approve', reason? }` | The first approve applies when nobody denied or asked; needs `approve` in `can` |
| `{ decision: 'rewrite', input }` (1 MiB) | Approves with new arguments; rewrites accumulate, the last one runs; needs `rewriteInput` in `can` |
| `note` (512 bytes, one line, any decision) | A transcript line `<Package>: <note>`; needs `ui.presentation` |
| `null` / nothing | No decision |

A **failure** (a throw, an invalid return, the budget passed, no running service) follows `onFailure`: `continue`
leaves the package out, `ask` shows the prompt with "`<Package>` did not answer (`<code>`). Decide yourself.",
`deny` denies with "`<Package>` did not answer (`<code>`)." A failure never approves. Revoke, disable and safe mode
remove the hook (R0503); they are not failures.

Every non-empty return gets one receipt (`panda.hooks.onApplied`):
`{ schemaVersion, hookId, event: 'tool.before', taskId, callId, applied, code?, overriddenBy?: { package }, refused? }`
(`refused.decision` / `refused.note`: `UnsupportedCapability` or `PermissionDenied`; `code: 'InvalidShape' | 'LimitExceeded'`
for an invalid return). An approve or rewrite overridden by another package's deny or ask, and an ask overridden by a
deny, say who won.

## What the host does

| Outcome | Permission request (source C) | Ask-at-host (source B) |
|---|---|---|
| deny | Answered "no" at once with the reason (`denyReason: answer`), or "no" followed by a live steer naming the package and the reason (`steer`: Pi, omp, Codex, OpenCode, Devin), or the bare "no" (`none`); the call's `tool.after` is `denied` with no output; a line "`<tool>` denied by `<Package>`. `<reason>`" | the same |
| approve / rewrite | Answered "yes" at once (the prompt never appears), with `updatedInput` for a rewrite where supported; a line "`<tool>` approved by `<Package>`." | the same |
| ask | The normal host prompt, with "`<Package>` asks you to decide: `<reason>`" | the prompt instead of the automatic answer |
| none | The normal prompt | Answered "yes" at once, as `full` would (not a standing-rule request, not a host tool that asks in every mode: those show the prompt) |

The details travel beside `RunInput::Approval` (R0502's `attach`/`take`); the adapter claims them once. `tool.after`
of a decided call carries `decidedBy` (the package). A request cancelled by the harness, or a run stopped, while the
chain runs gets nothing (no late prompt, no late answer).

Seam: `launch_operation_admitted` wraps the run's config and event sink (`runtime_hook_decisions::wrap`) just before
the provider starts; with no hook attached and no ask-at-host launch both are returned unchanged, and the approval
event is never held.

## Scoped full mode: ask at the harness, answer at the host

Only while an **enabled package holds an attached `tool.before` hook** whose `match` accepts the run's harness and
run kind, with `harness.hooks.observe` and (for some tool kind) `harness.hooks.decide` for the run's project, a `full`
run of one of OpenCode, Kilo, Cline, Kimi, Grok, Command Code, GitHub Copilot, Hermes or ZCode is launched in `ask`:
the harness asks before each tool in its normal asking set, and the host answers each request at once as `full`
would, unless a hook decides otherwise. The task's mode stays `full` (payloads say `mode: 'full'`, `source:
'askAtHost'`), and the transcript says so once per task. Not for the Claude Code family and Pi/omp (companions,
R0602), Codex, DeepSeek and Muse (their mode also selects the sandbox), Devin and Cursor (not established), or
Antigravity.

It takes effect at the next run started. Disposing the hook, revoking either grant, disabling the package or safe mode
restores the original `full` launch from the next run; a run launched ask-at-host keeps answering at the host until it
ends, so it never waits on a prompt `full` would not have shown. Warm spares are keyed by mode, so a spare launched for
one launch mode is never reused for the other.

## Coverage, as reported

`panda.harnesses.list` (R0509) now reports `decisions: 'delivered'`, and each `toolBefore[mode].can` is the `can` a
request of that harness offers there for a call the mode allows (for example `['deny', 'ask']` for Codex). Ask-at-host
stays a `feasible` cell (`sourceFeasible`: no installed harness was run), delivered while a deciding hook is held.
A permission request is `askedCalls` or `escalationsOnly`, never `everyCall`; only a companion (R06xx) or a host tool
covers every call.

## Refusal-test reconciliation (Q rows owned here)

This slice delivers one permissioned power: a package's service decides a tool call (`tool.before`, under
`harness.hooks.decide`, with positive, missing-grant, revoked and stale probes in its own spec and native tests).
The listed rows assert that declared, service-less contribution paths (thread-action kinds, composer controls, dock
and roster actions, BTW and board actions, presentation surfaces) and a package provider's own tool calls cannot answer
an approval. None of those assertions is a permissioned operation this slice delivers, so none is changed; each is
retained, with its non-security reason:

| Rows | Retained refusal | Non-security reason |
|---|---|---|
| Q001, Q046 (`respond_approval`, `respond_user_input` thread-action kinds) | the declared kinds do not validate | A declared action is a manifest button with no request identity: a decision reaches a request only through the hook chain, which knows the call, resolves several packages (deny wins, ask beats approve) and attaches the reason. A second path would bypass that resolution (predictability). Late answers are `panda.tasks.respond` (R0508) |
| Q002, Q068, Q094 (composer `approve`, `deny`) | refused / `PermissionDenied` | Same: the composer control has no request identity and would race the chain (predictability); the user's own buttons stay the host's |
| Q013, Q079, Q105 (action dock `approve`, `deny`, `answer`; `respond_approval` never called) | refused / `InvalidArguments` | Same; stale, replayed, forged and foreign-worker requests also keep their identity refusals |
| Q014 (roster `approve`, `answer`) | refused | Same |
| Q092, Q115 (BTW `approval-allow`) | refused / `InvalidArguments` | Same; BTW is a side conversation with no request of its own |
| Q126, Q127 (transcript and composer presentation: `respond_approval` never called) | no dispatch | A presentation surface renders; it does not act (fault isolation of the presentation slices) |
| Q034 (a package provider's `approved: true` on its own gated tool) | refused | The requester never answers its own request: the decision belongs to the user or a deciding hook, which this slice delivers (one decision path, predictability) |

## Columns and limits

- Preview/Node: the spec (both Playwright configurations, WebKit grep `extensions hook decisions:`, CI ports
  16451/16452). Native fixtures: `runtime_hook_decisions::tests` (the shared returns and actions, the `can`/coverage/
  launch table, the demonstration with a stand-in service through `prepare`/`run_chain`, a deny's reason and a
  rewrite claimed by the adapter, Codex refusing a rewrite, removing the hook restoring the launch). Installed service
  qualification with `sample.hook-guard` and any real harness capture: pending, not claimed. No harness was run.
- Companions (source A: Claude Code hook callbacks, the Pi bridge, Codex/OpenCode/Kilo plugins) are R0601–R0606;
  they hand their calls to the same fold.
- Package order is registration order and failure notices are R0506; `approval.*`/`question.*` events are R0507;
  answers after the budget (`panda.tasks.respond`) are R0508.
- One-way `tool.before` deliveries (no decider attached) keep R0503's `askedCalls` label; decided calls carry the
  precise coverage. A decided call's `tool.after` keeps R0503's source label.
- A request whose call the adapter did not record (some built-in arms record only at the permission request;
  PandaCode's own MCP tool prompts) cannot be decided: it takes the normal path (ask-at-host still answers it).
