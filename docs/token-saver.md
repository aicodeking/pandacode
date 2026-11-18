# Token saver

The token saver is per-thread response-style guidance (`src/token-saver.ts`, panel in
`src/token-saver-panel.ts`). Packs: Caveman (Lite, Full, Ultra), Lean code, Quiet tools, and
RTK (only when `rtk` is installed, detected by `token_saver_tools`). The chosen packs become one
folded block that starts with `Response style (PandaCode token saver` and is appended to a
message when the packs change and every `REMIND_EVERY` (8) messages.

The pack text lives once, in `src/token-saver-packs.json` (Caveman levels, the exceptions line
and the other packs' guidance). `guidance()` in `src/token-saver.ts` imports it for threads, and
`token_saver::guidance()` in `src-tauri/src/token_saver.rs` reads it with `include_str!` for team
workers. Both sides hash their output for all 96 pack, level and rtk combinations against the
same value (`guidance snapshot` in `tests/token-saver.test.mjs`, `guidance_snapshot` in Rust);
when you change the text on purpose, update both hashes.

## Team workers

The lead picks a token saver per worker. `pandacode_dispatch_workers` assignments, and
`pandacode_followup_worker`, and a direct worker's own `dispatch_workers` and `sub_workers`
(`followup` action) take an optional `tokenSaver` (schema type `["string", "object"]`):

- `{ "packs": ["caveman" | "lean-code" | "quiet-tools" | "rtk"], "level": "lite" | "full" | "ultra" }`.
  `level` is allowed only with `caveman`, and defaults to `full`. Unknown packs are refused.
  The same object sent as a JSON-encoded string is accepted.
- `"none"`: no saver.

`rtk` is taken as asked, without checking that it is installed: the rtk pack itself says to
run a command plainly when rtk rejects it.

**Default.** When a dispatch omits `tokenSaver`, the worker gets none: the dispatching thread's
own saver is not inherited (S1v3 measured no saving from packs, and an inherited block adds about
5.8% input). When a follow-up omits `tokenSaver`, the worker keeps its own packs
(`resolve_saver` in `architect/saver.rs`).

**Result.** The dispatch result lists what each new worker got, for example
`"tokenSaver": ["Docs: none", "Engine: caveman/lite+quiet-tools"]`. A follow-up
answers with `"tokenSaver": "lean-code+quiet-tools"`.

**Applying it.** The worker's saver is saved on the worker (`Worker.tokenSaver` in the team
snapshot; the request JSON in `architect_requests` keeps the field only when it was given, so
idempotency keys of older requests are unchanged). Each launch from the assignment (dispatch,
follow-up, failover) appends the thread block without its `subagents` sentence
(`token_saver::worker_guidance`). A follow-up that switches a worker from packs to `"none"` appends the switch-off block once
(`Applied.switchOff`); a worker that never had packs never gets one. A parked worker that resumes with its
sub-workers' results stays in the same conversation and does not get the block again.

**Lead guidance** (in the dispatch tool description):

> tokenSaver: "none" or {packs: caveman|lean-code|quiet-tools|rtk, level: lite|full|ultra,
> caveman only}; default "none". Measured: packs did not cut worker cost; leave it unless the
> user asks. lean-code+quiet-tools for edits is optional and unproven.

The S1v3 benchmark ([token-saver-benchmark.md](token-saver-benchmark.md)) found no output-token
or cost saving from lead-chosen packs on worker runs (output -1%, cost +1%, both within noise),
because output is about 1% of a worker's tokens; see [worker-tokens.md](worker-tokens.md) for
where worker tokens actually go. Edits showed -11% output (not significant), so the guidance calls lean-code+quiet-tools for edits
optional and unproven.

The benchmark extracts this text from `tokenSaver:` onward, so keep that prefix. An explicit
level is used as given.

**Pack wording for agents.** Caveman's exceptions keep reports to the lead complete and
unambiguous. Quiet tools leaves the explore tool and Claude Code's
edit guidance to the app instructions (`LOOK`, `EDIT_CLAUDE` in `lib.rs`); the rtk pack offers
`rtk read` and `rtk grep` only when the explore tool is not listed.

**UI.** The worker card in the team panel shows the packs as chips (`Caveman lite`,
`Quiet tools`).

## Harness subagents

The `subagents` sentence in `src/token-saver-packs.json` ends every active thread block (never a
switch-off): it asks the agent to start each prompt it gives its own subagents (Claude's Task tool
and similar) with a "Response style:" line that asks for the same style and its exceptions. It
is sent only while a style is active, so it is no longer in the app instructions. Worker blocks
(`token_saver::worker_guidance`, `Applied::block`) leave it out.
