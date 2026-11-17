# Prompt context, result rewrites and compaction answers (runtime slice R0504)

Native owner: `src-tauri/src/extensions/runtime_hook_context.rs`. Preview twin: `src/extensions/runtime-hook-context.ts`.
Fixtures: `tests/fixtures/extensions/runtime-hook-context/` (`extension.json` + `main.cjs`, the package
`sample.hook-context` named "Recall"; `returns.json`, the scripted returns both folds read; `compaction.json`, a
`sinceCompaction` script; both `synthetic`). Spec: `tests/extensions-runtime-hook-context.spec.ts` (preview/Node
column). Native: `runtime_hook_context::tests`.

R0503 delivers every hook one way. This slice makes the host **await** three of them and apply what they return:
`prompt.submit`, `tool.after` (where the host serves the call) and `compaction` (before a compaction the host sends).
Decisions on `tool.before` are R0505; chain order settings and failure notices are R0506.

## The awaited chain

The host asks every attached hook of the event whose `match` filter and `harness.hooks.observe` grant accept the
occurrence, one package after another (registration order; R0506 adds the user's order), with the frame
`{ schemaVersion: 1, hookId, event, observeOnly: false, payload }`. The node host runs the package's handlers of that
event in order and answers with the first value one returns (`null` when none does); a handler that throws answers
its error code. Each package has its declaration's `budgetMs`; the whole chain has 60 s. Each package sees what the
earlier ones changed (the rewritten prompt, the rewritten result).

**Failure** (a throw, an invalid return, the budget passed, no running service) follows `onFailure`: `continue` (the
default) leaves that package's part out; `deny`, accepted only on `prompt.submit`, refuses the send. A failure never
approves and never changes the message by itself.

Every non-empty return gets one **receipt**, delivered with `panda.hooks.onApplied(handler)`:

```ts
{ schemaVersion: 1, hookId, event, taskId, callId?, applied: boolean,
  code?: 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidShape' | 'LimitExceeded',   // when nothing applied
  refused?: { [key: string]: 'PermissionDenied' | 'UnsupportedCapability' } }              // each part not applied
```

## `prompt.submit`

Runs in `launch_operation_admitted` **before the message is saved**, for every harness (the host owns the text),
when a run sends a user message (not for goals, cloud re-attach, coordination turns or commands a caller prepared).
A typed slash command other than `/compact` passes unchanged and takes no notes (`carries_context`).

| Return | Needs | Effect |
|---|---|---|
| `context: string` (64 KiB) | `harness.hooks.context` | Appended after the message under `Extension context from <Package> (not written by the user):` |
| `prompt: string` (1 MiB) | `harness.hooks.decide` | Replaces the message; a transcript line "Message rewritten by <Package> before it was sent. You wrote: …" keeps the original |
| `block: { reason }` (4 KiB) | `harness.hooks.decide` | Ends the chain; the send fails with `Not sent: blocked by <Package>. <reason>` and the composer puts the message back into the draft |
| `note: string` (512 bytes, one line) | `ui.presentation` | A transcript line `<Package>: <note>` |

A part without its permission is ignored (receipt `PermissionDenied`); the rest of the return still applies. A hook
declared `onFailure: "deny"` that fails refuses the send with `Not sent: <Package> did not answer (<code>).`

The task's waiting **`forModel` notes** (R0402, `panda.tasks.note`) are taken here, through
`runtime_tasks_messages::take_context`, the one reader, and appended as R0402's labelled block. A blocked or refused
message gives them back (`restore_context`), so they ride the next message.

The transcript shows what the user wrote; the context and note blocks (trailing, and the leading notes block of a
message a package sent) fold into one collapsed `<details class="message-context hook-context">` whose summary
names every package: `Context added by Recall, Messenger` (`splitHookContext`, `hookContextHtml` in the twin,
used by `userContent` in `src/main.ts`). The model receives the blocks in the message.

When the chain asked anyone, `turn.start`'s report does not deliver `prompt.submit` a second time.

## `tool.after`

| Call | `source` | `can` | A returned `output` |
|---|---|---|---|
| PandaCode's own tools of the run (`with_result_hooks` around the run's tool host) | `hostTool` (`tool.owner: 'panda.core'`) | `['rewriteResult']` for a completed call | needs `harness.hooks.decide`; the rewritten value is what the harness, and so the model, receives; a line "Result of <tool> rewritten by <Package>." |
| A call the harness runs | `permissionRequest` / `activity` (R0503) | `[]` | not applied: these deliveries stay one way (`observeOnly: true`) |

Rewrites accumulate: the last one is what the model gets. A host tool that failed passes its error unchanged. The
activity row of a host-served call does not deliver a second `tool.after` (`take_hosted`).

Denied and cancelled calls still produce `tool.after`, without invented output: a call whose permission request was
denied (`answered`, called by `respond_approval`) reports `status: 'denied'` and `output: null` whatever decline
text the harness echoes; a denied or cancelled row with no output reports `output: null`; and a call whose
`tool.before` was reported but whose row never came is delivered at the end of the turn (`flush_unpaired`) as
`denied` when its request was denied, else `cancelled`, with `output: null`.

## `compaction`

| Phase | When | `can` |
|---|---|---|
| `before` | A typed `/compact`, before the host sends it | `cancel` always; `instructions` where the harness's `/compact` takes them (Claude Code, GLM, MiMo, Alibaba) |
| `after` | A finished "Compact context" step (R0503) | `[]` |

`summary` is never offered: no harness takes a supplied summary on the host path. A part `can` does not list is
ignored with `UnsupportedCapability`; a listed one needs `harness.hooks.decide`. `cancel` refuses the command
(`Compaction cancelled by <Package>. <reason>`, back to the draft); instructions are appended to the command, with
a transcript line naming the packages.

**`sinceCompaction`** counts the turns since the last compaction: 0 for the turn that follows one (and for the rest of
the turn it happened in), `index - 1` when there was none. A compaction step is counted once however often it is
reported (the same dedupe as the workspace event `task.compacted`, which fires for the same step), and it is recorded
even when no hook observes the run or no turn runs, so a hook attached later still reads the right count.

## Columns and limits

- Preview/Node: the spec (both Playwright configurations; CI ports 16401/16402). Native fixtures:
  `runtime_hook_context::tests` (the shared returns, the awaited chain with a stand-in service including a budget
  that passes, receipts, `sinceCompaction`, a denied call). Installed service qualification (the real node host with
  `sample.hook-context`): pending, not claimed. No real harness was run.
- `sinceCompaction` lives in memory: after a restart of the app it counts from the task's first turn again.
- Result rewrites of harness-run calls need a companion (R0505 and the companion slices); this slice reports
  `can: []` for them.
- Several handlers of one event in one package: the first that returns a value answers for the package.
