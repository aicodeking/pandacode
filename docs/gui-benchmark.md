# GUI launch benchmark (batches G1 and G2)

How fast and how cheaply the same agent, Claude Code with Sonnet, works when it is launched the way each GUI launches it: plain `claude -p`, T3 Code, and PandaCode. Runner: `scripts/agent-bench/gui.mjs` (tests in `gui.test.mjs`, launch snapshot and task list in `tasks-gui.json`). House standards follow [agent-loop-benchmark.md](agent-loop-benchmark.md) and [worker-tokens-benchmark.md](worker-tokens-benchmark.md).

**What is not measured.** GUI time is not measured: rendering, startup, typing, approvals and anything else a person does in a window. The benchmark compares only the agent work each launch produces: the harness flags, the system prompt additions, the MCP tools listed and the first message, on the same tasks, model, harness and machine.

## What each launch adds

Every arm runs the pinned harness (2.1.317, `~/Library/Caches/pandacode-bench/v2/harness/claude`) with the same house flags (`common()` in `gui.mjs`): stream-json in and out, `--model sonnet` (must resolve to `claude-sonnet-5-5`), `--strict-mcp-config`, `--setting-sources project` on a checkout with no `.claude/`, `CLAUDE.md` or `.mcp.json`, `--no-session-persistence`, and a per-run `--max-budget-usd`. Only the lines below differ.

| Arm | Flags | System prompt addition | MCP tools | Message |
|---|---|---|---|---|
| **PLAIN**, `claude -p` | `--dangerously-skip-permissions` | none | none | the task |
| **T3**, T3 Code | `--thinking=adaptive --thinking-display=summarized --effort=high --tools=default --include-partial-messages --add-dir=<cwd> --settings={"showThinkingSummaries":true} --permission-mode bypassPermissions --allow-dangerously-skip-permissions`; env `CLAUDE_CODE_ENTRYPOINT=sdk-ts` | 5,366 bytes: runtime info, pull request linking, T3 orchestration, visuals and preview, background wait | `t3-code`: 71 tools, 48,119 bytes of names, descriptions and schemas; `request_secret` is loaded up front, the rest may sit behind ToolSearch | the task |
| **PANDA**, PandaCode plain task, Full access | `--include-partial-messages --replay-user-messages --permission-mode bypassPermissions --allow-dangerously-skip-permissions --disallowedTools=ScheduleWakeup,Monitor,CronCreate` | `app_instructions` for a plain task, 6,279 characters: sidebar titles, run script, change tracking, turn ends, `LOOK` + `EDIT_CLAUDE`, `SAVE`, rich questions, generative UI, visual progress | fresh-install task catalog: 17 tools, or 22 for mobile checkouts; four real hosts and app stubs (G1-1 below) | the task |
| PANDA_W (optional, descriptive), round 18 team worker | as PANDA, but `--disallowedTools` is S3's NEW list (`armFlag('NEW', ro\|rw)`: read-only for localization, writer for edits) | worker `app_instructions`, 1,372 characters: change tracking, turn ends, `LOOK` + `EDIT_CLAUDE` | `pandacode_explore` | the worker brief's report sentence, then the task |

**T3 Code.** Commit `25bf84ab07f53f141c20239c63e383823a9d5ea0` of `github.com/pingdotgg/t3code` (2026-11-07), Agent SDK `@anthropic-ai/claude-agent-sdk` 0.3.316.
- `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, `makeClaudeQueryOptions` (lines 1751–1910): preset `claude_code` tools and system prompt, `append` = `buildRuntimeInstructions({ harness: "Claude Code" })` plus `T3_CODE_ORCHESTRATION_INSTRUCTIONS` and `CLAUDE_BACKGROUND_WAIT_INSTRUCTIONS` whenever the thread has an MCP session, adaptive thinking with summarized display, `includePartialMessages`, the model's catalog effort (`high` for Sonnet 5.5), `additionalDirectories` = cwd, and no `settingSources`. Call site lines 10917–10960; the MCP server is `claudeMcpQueryOverrides` (lines 2011–2039), an HTTP server named `t3-code` with every T3 tool allowed.
- Permission mode, lines 2800–2830: full access (approval policy `never`, `dangerFullAccess`) is `bypassPermissions`.
- `packages/provider-core/src/server/runtimeInstructions.ts` and `orchestrationInstructions.ts` hold the text; `apps/server/src/mcp/McpHttpServer.ts` `layerTools` (lines 1232–1245) is every tool the server advertises.
- The SDK's `ProcessTransport.initialize` (`sdk.mjs`) maps these options to CLI flags (table above), sets `CLAUDE_CODE_ENTRYPOINT=sdk-ts`, passes no `--setting-sources` when `settingSources` is unset, and sends `append` in its initialize request.

The snapshot in `tasks-gui.json` was taken by running T3 Code's own code at that commit, not by copying text: a test modelled on its `AgentContextBudget.test.ts` called `makeClaudeQueryOptions` and registered `McpHttpServer.layerTools` with mocked services, then wrote the query options, the append and the advertised tool list. Its sizes equal the commit's `agentContextBudget.json` (`claudeSystemAppendBytes` 5366, `mcpToolListJsonBytes` 48119), which `gui.test.mjs` asserts.

**Plain Claude Code.** `claude -p` with its defaults: no added prompt, no MCP server, permissions skipped.

**PandaCode.** This tree's `configure_command` in `src-tauri/src/providers.rs` (the Claude branch) and `app_instructions` in `src-tauri/src/app_instructions.rs` (it takes `&InstructionOptions`), called with `chat = false`, a non-worker role, explore on for Claude Code, and an empty tool store (`tools: true`, so `SAVE`). The text is read from the live sources at `--prepare` and pinned (`pandaInstructions` in `gui.mjs`; `gui.test.mjs` checks it against `providers.rs` and `lib.rs`). Before the first G1 call, deviation G1-1 replaced the initially planned two-tool server with `panda_catalog_mcp_serve`: a fresh-install task's whole catalog, with explore, tool save, file tracking and title responses real, and the remaining app tools stubbed. G1 uses `bin-g`; G2 reuses its identical optimized bytes in `bin-g2` with a separate private grading cache. PANDA_W is round 18's worker launch as S3's NEW arm ran it, with the worker text `app_instructions(&InstructionOptions { role: <worker role>, .. })` builds. G2's registered texts (plain task 6,279 characters, worker 1,372, as in the table above) predate the current app text; re-registration is described once, with the live sizes, in [agent-loop-benchmark.md](agent-loop-benchmark.md#batch-fv2-pre-registration) (`--batch` refuses until then).

**How faithful each arm is.** Known differences, all written down before any run:
1. **PANDA catalog correction before runs.** The original plan listed only two tools. G1-1 added the real fresh-install task catalog before any G1 smoke or main call; G2 retains it. See the registered deviation for its composition, stubs and remaining configuration limits. The per-message `<PandaCode task metadata>` title note is still left out (about 30 tokens).
2. **T3's MCP server is a stand-in.** `gui.mjs --t3-stub` serves the snapshot's exact tool list (names, descriptions, input schemas, `_meta`) over stdio under the name `t3-code`; every call returns an error and does nothing. T3's prompt says ordinary coding tasks need no T3 tools, so a call is a deviation from the task, not lost work; each run records its T3 calls (`t3Calls`). The runner aborts if a T3 run's `init` does not show `t3-code` connected.
3. T3's append travels as `--append-system-prompt` rather than in the SDK's initialize request; the text is the same. `--permission-prompt-tool stdio` (both GUIs) is left out: nothing answers it headless, and bypassPermissions does not ask. The SDK's `--session-id` and PandaCode's `--resume` do not apply to a single fresh turn.
4. **User configuration is held out of every arm.** Both GUIs and plain `claude` load the user's own settings, `CLAUDE.md`, skills, plugins and hooks. Those belong to the user, not to the GUI, so every arm runs with `--setting-sources project` and none of them.
5. Effort differs by design: T3 passes `--effort high`; PLAIN and PANDA leave the model's default. That is part of how each GUI launches.

**Other GUIs, not replicated.**
- Claude Code desktop and web (claude.ai/code), Conductor, Cursor and other closed-source apps: their launch cannot be read, only guessed.
- The Claude Code IDE extensions: they drive the same harness from an editor whose context (open files, selections) is the point, which a headless run cannot reproduce.
- Open-source wrappers such as opcode (Claudia) and Crystal: not inspected for this batch. They would be cheap only if they launch `claude -p` with fixed flags and no own MCP server; adding one later is a new batch, not a deviation.

## Pre-registration

<!-- prereg:G1 -->
### Pre-registration: batch G1

Written on 2026-11-07, before any G1 run and before any smoke. One harness call was made while writing it: a probe of `claude -p` with no tools ("Reply with OK only."), $0.027, to see whether the subscription limit was in effect. It was not; no other model call was made.

**Question.** With the same model, harness and tasks, do the launches of T3 Code (T3) and PandaCode (PANDA) take fewer or more steps, and bill less or more, than plain `claude -p` (PLAIN)? Do they hold localization quality and edit pass rate?

**Arms.** PLAIN, T3 and PANDA as in "What each launch adds" above (`armLaunch` in `gui.mjs`, the T3 snapshot pinned by `tasks-gui.json`, the PandaCode texts pinned by `--prepare`). PANDA_W runs in the same batch, interleaved, and is descriptive only: no test, no gate, no Holm. All four share the house flags, the pinned harness **2.1.317** and model **sonnet → `claude-sonnet-5-5`**. A run whose `init` names another model or harness version aborts the batch, and so does a T3 run without `t3-code` connected. The explore server is `bin-g`, an optimized (`fast-release`) snapshot of this tree made by `run.mjs --prepare --edit-v2 --snapshot bin-g` before the batch; `batch.json` pins its sha256, the harness, the task files, the T3 snapshot and every launch text, and `gui.mjs` refuses to run if any of them changed since `--prepare`.

**Tasks.** 40, all from earlier batches with their gold, tests and sanity verdicts (`loadGui`): the 20 tuned localization tasks of `tasks.json` (13 PandaCode, 6 Outline, 1 VS Code), its 6 edit tasks, and the 14 `edit2` tasks of `tasks-edit-v2.json` (8 Hono, 6 PandaCode). All 20 edit tasks are `ok` in `sanity.json`. Held-out tasks are not used. Localization runs get `localizationSuffix`; grading is `gradeLocalization` (recall, precision) and `gradeEdit` (the commit's tests plus the suite, new failures only), as in batches E and Fv2.

**Seeds and order.** 3 seeds (1, 2, 3): 40 tasks × 3 seeds × 4 arms = 480 runs. Each (task, seed) runs its arms next to each other in a shuffled order; groups are shuffled by the batch seed in `batch.json` (`seededJobs`). Concurrency 4.

**Primary.** Steps and billed cost (`total_cost_usd` of the transcript's last result) of T3 and of PANDA against PLAIN: four tests. Per task, d = log(mean arm / mean PLAIN) over seeds; a two-sided Wilcoxon signed-rank test on d (`stats.mjs`), and a 95% bootstrap CI of mean d, reported as exp(mean d) − 1 (`logRatio` from `s3.mjs`). The four p-values are Holm-adjusted together. A measure reads "lower" or "higher" only if its Holm p < 0.05 and the CI excludes 0; otherwise "not shown to be lower" or "not shown to be higher".

**Also reported for each primary, with no test:** the ratio of means (mean arm / mean PLAIN − 1 over task means) and the absolute difference per run (mean arm − mean PLAIN: steps, dollars), each with a 95% bootstrap CI over tasks (`ratioOfMeans`), and the PLAIN and arm means.

**Gates,** per arm against PLAIN, non-inferiority: the lower end of the 95% bootstrap CI of the mean per-task difference must be above the margin (`nonInferior` in `analyze.mjs`).
- Recall and precision, 20 localization tasks, margin −0.05 (the registered margin of batches E and Fv2).
- Edit pass, the 20 edit and edit2 tasks pooled, margin **−0.20**.

Margins come from `gui.mjs --simulate`, which resamples BEFORE's runs in E, E2 and Fv2 (no MCP server and no instruction, the arm closest to PLAIN) at G1's design. 800 simulated batches per cell:

| Gate, 3 seeds | P(pass), no effect | P(pass), true loss 0.10 |
|---|---:|---:|
| Recall, −0.05 | 0.98 | 0.00 |
| Precision, −0.05 | 0.83 | 0.00 |
| Edit pass pooled, −0.05 / −0.10 / −0.15 / −0.20 | 0.13 / 0.32 / 0.58 / 0.82 | 0.01 / 0.04 / 0.12 / 0.29 |

At 2 seeds the edit gate passed 41% of the time with no effect even at −0.15, so the batch runs 3 seeds. At 3 seeds −0.20 is the narrowest margin that passes a true no-effect arm at least 80% of the time; it catches a large loss, not a 10-point one, and the observed difference and its CI are reported whatever the verdict. A failed gate is reported beside the arm's speed and cost; it does not change the primary's test.

**Descriptive:** wall time, output tokens, cache-read and cache-write tokens, first-step cache write (what each launch's prompt and tool list cost to write), steps and cost by set (loc, edit, edit2), tools listed in `init`, T3 tool calls per run, explore calls, and all of PANDA_W against PLAIN.

**Power.** `gui.mjs --simulate`: each of 40 units draws its seeds from one task's BEFORE runs (steps or cost) in E, E2 and Fv2, the arm's draws times (1 + effect), plus a normal per-task spread τ on the log scale. The rule is the primary's with a Bonferroni bound on Holm (p × 4 < 0.05) and the normal-approximation Wilcoxon. 400 simulated batches per cell, 3 seeds:

| P(reads lower) | Steps, τ 0.05 | Steps, τ 0.15 | Cost, τ 0.05 | Cost, τ 0.15 |
|---|---:|---:|---:|---:|
| No effect | 0.01 | 0.01 | 0.02 | 0.01 |
| −10% | 0.99 | 0.80 | 1.00 | 0.94 |
| −15% | 1.00 | 1.00 | 1.00 | 1.00 |

The units are tasks, which are independent here, unlike S3's correlated units. The BEFORE runs come from an older harness and engine, so the spread is an estimate.

**Expectation, written down before running.** T3's first-step cache write is largest (about 12k more tokens of tools and text if Claude Code lists T3's tools in full, far fewer if it defers them behind ToolSearch); with `--effort high` and adaptive thinking its output is likely higher, so its cost is expected higher than PLAIN's (+10% to +40%) and its steps about the same. PANDA is expected to take fewer steps than PLAIN on localization (batch E and Fv2: about −17%) and about the same on edits, with cost from −10% to +5%. Quality: no gate failure expected.

**Shared machine.** Other PandaCode tasks and builds run on this Mac during the batch. Wall time is descriptive only, edits build in their own APFS clone of the warmed dependency cache with `CARGO_INCREMENTAL=0`, nothing starts below 6 GiB free, and the runner signals only PIDs it started. Steps, tokens and billed cost do not depend on machine load.

**Cost.** About $95: `gui.mjs --plan` estimates $74 for the three registered arms (360 runs at batch E's $0.17, plus $0.10 per T3 run and $0.01 per PANDA run for their larger prompts) and $95 with PANDA_W. Per-run cap $3, total budget $150.

**Exclusions.** None by outcome. A run that times out or errors counts with the steps and cost it reached and fails its grade. Runs off the pinned model are dropped by `--analyze` and reported. If the smoke shows the harness refusing a T3 flag (`--thinking`, `--thinking-display` are hidden flags), the batch does not start; any change to an arm after this registration is a written deviation.

**Commands.**

```sh
node scripts/agent-bench/run.mjs --prepare --edit-v2 --snapshot bin-g   # optimized explore server of this tree; no model time
G="node scripts/agent-bench/gui.mjs"
$G --prepare                       # pins the PandaCode texts, the T3 snapshot, bin-g and the harness
$G --plan --arm PLAIN,T3,PANDA,PANDA_W
$G --simulate                      # the gate and power tables above
$G --smoke --arm PLAIN,T3,PANDA,PANDA_W --tasks loc-agent-env,e2-ho-etag-commas   # seed 99, never analysed
$G --batch G1 --arm PLAIN,T3,PANDA,PANDA_W --concurrency 4
$G --analyze --summary scripts/agent-bench/results/gui-G1.json
```
<!-- /prereg:G1 -->

`node scripts/agent-bench/gui.mjs --register` appended this section's sha256 and the pinned files to `scripts/agent-bench/results/preregistrations.jsonl`.

### Batch G1 deviations

<!-- deviation:G1-1 -->
**G1-1** (2026-11-07, after registration, before `bin-g` was built and before any smoke or batch run). **PANDA now lists a real task's whole tool catalog.** This removes a bias in PandaCode's favour (faithfulness item 1 above).

- **Before:** PANDA's MCP server (`custom_tools_mcp_serve`) listed only `pandacode_explore` and `pandacode_tool_save`.
- **After:** PANDA's server is the new ignored test `panda_catalog_mcp_serve` in `src-tauri/src/providers/mcp_host/tests.rs`. It builds `bench_panda_host`, which follows the composition in `lib.rs` (`with_jev` … `session_titles::with_host`, in that order) for a local, non-team, Full access Claude Code task on a fresh install on Apple silicon. Those defaults are: Jev off, agents may schedule, no VM or sandbox, machine orchestration off, no deploy account, not a bot task, explore on, an empty agent-made tool store. The resulting catalog is:
  - **served for real:** `pandacode_explore` and `pandacode_tool_save` (as before), plus `pandacode_track_files` (a real `turn_changes::Tracker` over the checkout) and `pandacode_title` (no title run, so it answers `{"staged":false}`, as the app does when a turn has no title to suggest);
  - **exact specs from each module's own catalog function, every call failing with "PandaCode's app is not connected in this benchmark run. Continue without this tool." (the T3 stand-in's treatment):** schedules (4), VM list and manage (`FIRST_VM_TOOLS`), design (4), progress snapshot, and run/preview (2, copied from the private `preview_catalog`; a test checks the copy against `agent_tools.rs`);
  - **the simulator tools (5),** added only when the checkout holds an iOS or Android project. `mobileProject` in `gui.mjs` ports `has_mobile_project`, so PandaCode checkouts with `mobile/` get them, as in the app.
  - The server is still named `pandacode_architect`. Its listing goes through the real `listing()`, so only explore and track_files carry `alwaysLoad`.
- **Sizes,** measured as the UTF-8 bytes of the JSON `tools` array that tools/list returns:

  | Arm | MCP tools | Bytes |
  |---|---:|---:|
  | PLAIN | 0 | 0 |
  | T3 | 71 | 48,157 |
  | PANDA (before G1-1) | 2 | — |
  | PANDA, non-mobile checkout | 17 | 13,835 |
  | PANDA, mobile checkout | 22 | 16,362 |
  | PANDA_W | 1 (explore) | — |

  T3's 48,119 above is T3's own `mcpToolListJsonBytes`. By this measure the same list is 48,157 bytes.
- **Runner:** `gui.mjs --prepare` dumps the catalog (`panda_catalog_dump`) from `bin-g` and records the sizes in `meta.json`. A PANDA run aborts the batch if `pandacode_architect` is not connected in its `init`, as T3's does. Each PANDA run records `mobile` and `pandaStubCalls`, its calls to stubbed tools, which are reported descriptively. `--analyze --csv` writes the run table. The G1 entry's `gui.mjs` pin is released, and this entry pins the new file.
- **Unchanged:** the arms' flags, texts and message, the tasks, seeds, primary tests, gates, Holm family and wording. PANDA_W stays as registered: explore only, descriptive.
- **Still not replicated:** tools that a fresh install does not list, which are Jev, deploy, machines, bot tools and the full VM set (which appears once the user has a VM). The per-message title note (about 30 tokens) is also still left out.
<!-- /deviation:G1-1 -->

<!-- deviation:G1-2 -->
**G1-2** (2026-11-08, before resuming the stopped batch). **Stop on invalid harness measurements.** The previous worker had already built and prepared `bin-g`, registered G1-1, completed the eight all-arm smoke runs and 21 of 480 G1 runs, then stopped at the 6 GiB disk floor. The resumed worker inspected those records before editing; none has empty output, zero billing, a result error or a pin mismatch. The ledger totals $5.1926128, including $1.9673977 for smoke and $3.2252151 for G1. All original registrations, raw runs, binary, launch texts and batch seed remain in place; completed runs are not repeated.

- `gui.mjs` now stops scheduling after a quota/rate-limit error, missing or zero billing, empty model output, harness result error, timeout or nonzero exit. The attempt is saved with `invalid` and `success: false`; already-running jobs finish and remain recorded. Task grading failures keep their registered treatment. No automatic retries are added. A stopped batch is incomplete; invalid harness attempts cannot be used as performance results, and `--analyze` refuses them. No final primary/gate claim is made for an incomplete batch.
- Sanitized summary and CSV writes now use the existing `assertSanitized` check. This changes no numbers.
- The read-only launch audit found no T3 ToolSearch treatment bug under the registered user-configuration holdout: at the pinned commit, `claudeToolSearchOverride(undefined)` returns `undefined`. Only explicit `auto` or interior `auto:N` settings become `true`. The runner strips the user's environment value and settings, so forcing `true` would change the treatment. T3 remains as registered.
- **Catalog measurement correction:** the prepared binary serves PANDA's 17-tool non-mobile list at **13,861 bytes**, and its 22-tool mobile list at **16,388 bytes** (JSON UTF-8). G1-1's illustrative measurements above were 26 bytes lower; the actual catalog and its cached hash are unchanged. T3 remains 48,119 bytes without metadata and 48,157 with metadata; its 5,366-byte append is separate.
- Fresh no-model regression tests cover the stop decisions, including a failed task grade and ordinary answer text mentioning quota. The optimized `bin-g` snapshot is reused because its binary, sources and launch hashes match the prepared pins; rebuilding or preparing over the existing snapshot would break that evidence.
- Unchanged: the four arms, all 40 tasks, three seeds, model/harness/MCP pins, $3 run cap, $150 operational budget, concurrency 4, 6 GiB disk floor, primary tests, gates, CIs, Holm family and batch order. This entry supersedes G1-1 only to release and repin `gui.mjs`; task pins are repeated unchanged.
<!-- /deviation:G1-2 -->

<!-- deviation:G1-3 -->
**G1-3** (2026-11-08, before any resumed model call). **Narrow G1-2 to infrastructure anomalies.** The pre-run review caught G1-2's stop rule treating ordinary paid harness failures as invalid. No model run used that rule. The registered G1-2 text and entry remain unchanged; this entry supersedes its runner pin.

- Stop only for quota/rate-limit errors identified in structured result/error events, missing or zero billing, or empty model output/steps. Save the attempt and stop further scheduling; retain every raw outcome. An invalid infrastructure attempt blocks performance analysis rather than being silently excluded.
- Ordinary paid run-cap exhaustion, timeouts, nonzero exits and task failures remain measured failures with their reached steps and cost, as G1 originally registered. An edit's successful test grade cannot override a timeout, result error or nonzero harness exit. The tests cover these distinctions and do not match quota words in ordinary source/tool text or successful answer text.
- Keep every other G1-2 safeguard and measurement correction, all original registrations and raw outcomes, and every G1 design/pin/budget unchanged. No model call occurred between the two deviations.
<!-- /deviation:G1-3 -->

<!-- deviation:G1-4 -->
**G1-4** (2026-11-08, still before any resumed model call). **Finish the pre-run guard review.** The guard now reads only structured error fields (`subtype`, `errors`, error type/code/message), never an errored result's echoed answer/source body. It also recognizes an anchored final service-denial message, honors a saved `invalid` reason during analysis, and stops scheduling after a pre-model setup exception yields missing measurements. Ordinary paid failures remain as G1-3 specifies. Regression tests cover source/tool-text negatives, a paid final denial, persisted invalid records, and the real pool retaining completed/in-flight records while leaving later jobs unstarted.

`pinnedSeed` already permits runner-code changes with a console note and strictly checks every treatment pin. Resume keeps the original `batch.json` and seed (877740526), its historical runner hash and all old run hashes; new runs record the new runner hash. Existing runner tests check same-seed reuse after runner drift and refusal of changed treatment pins. No compatibility bypass or repinning of the batch is added. This entry supersedes G1-3 only to repin the reviewed runner; all other design, analysis and operational guards remain unchanged.
<!-- /deviation:G1-4 -->

## Results: incomplete, awaiting the pinned build cache

The 2026-11-08 resume preflight found **21 of 480 G1 runs complete**, with 459 remaining. The earlier worker had completed the eight all-arm smoke runs and stopped G1 when disk space fell below its 6 GiB floor. None was repeated. All 29 cached runs have billed, nonempty outputs, Claude Code 2.1.317 and `claude-sonnet-5-5`; required MCP servers connected, and binary, source and launch pins match. G1 billed **$3.2252151**, smoke **$1.9673977**, ledger total **$5.1926128**. This resume has made no model calls and spent $0.

| Completed G1 runs | PLAIN | T3 | PANDA | PANDA_W |
|---|---:|---:|---:|---:|
| Count | 6 | 5 | 5 | 5 |

**Current blocker:** `assertBuild(meta.build)` fails because `src-tauri/target/debug/deps` is missing. Its registered artifact-name fingerprint is `6e21a7338dd0b5ea0628f21aae5a83f14680ceb5f38881badadc59c8426a6e83`; the current fingerprint is absent. Rust edit checkouts clone that cache, so the full registered batch cannot resume until the matching cache is restored or a reviewed, documented alternative preserves validity. No task subset or model/harness substitution was run around this blocker.

Fresh no-model checks: `node --test --test-reporter=spec scripts/agent-bench/*.test.mjs` **93/93 passed**; the optimized snapshot's `providers::mcp_host::tests::bench_` filter **3/3 passed**; a live HTTP MCP self-check passed initialization, 17-tool listing, always-load metadata, stub refusal, real title response and real explore search. The first HTTP check used the wrong explore argument (`queries`); it was corrected to the advertised `search` schema and rerun successfully. No rebuild is claimed: the existing optimized snapshot was verified and reused.

The sanitized [partial summary](../scripts/agent-bench/results/gui-G1.partial.json) and [all completed G1 rows](../scripts/agent-bench/results/runs/gui-G1-partial.csv) preserve the incomplete state. The task/seed coverage is unequal and insufficient for the registered final comparison. **No final quality-gate, CI, Holm-adjusted significance, speed or cost conclusion is claimed.** Tasks, seeds, gates and outcomes remain unselected; all raw records and original registrations remain intact.

## Fresh-cache restart: batch G2

<!-- prereg:G2 -->
### Pre-registration: batch G2

Written on 2026-11-08 before any G2 model call. G1's 21 completed runs and eight smoke runs are known, preserved separately, and never pooled into G2. A bounded search of 16,849 directories found five dependency-cache candidates and no authentic match for G1's missing 2,585-artifact fingerprint. The restart is required by that missing build cache; it changes no tasks, launches or outcome-based choices.

**Design and analysis.** Repeat G1's complete fixed design: PLAIN, T3, PANDA and descriptive-only PANDA_W; the same 20 tuned localization, six edit and 14 edit2 tasks; seeds 1, 2, 3; **480 main runs**, interleaved at concurrency 4. Use batch seed **877740526** to retain the original task/arm order. No held-out or extra tasks. Keep the original prompts, gold files, tests, worker messages, launch texts, flags, T3 catalog and default ToolSearch treatment. Claude Code stays **2.1.317**, `sonnet` must resolve to **`claude-sonnet-5-5`**. Verify model, harness and required MCP connections and stop on a mismatch.

The four co-primary tests are unchanged: steps and billed cost, each of T3 and PANDA versus PLAIN, per-task log ratios of means across three seeds, two-sided Wilcoxon, 95% bootstrap CIs and one four-test Holm family. Report ratios of means and absolute differences with task-bootstrap CIs too. The unchanged non-inferiority gates are localization recall and precision at margin −0.05 and pooled edit pass at −0.20. PANDA_W, wall time, token/cache measures, tool listing and stub calls remain descriptive. G1's simulations, power assumptions and written expectations stand; no tuning follows its partial results. Full analysis requires complete coverage, with no selective exclusions.

**Fresh cache and preserved evidence.** A separate worker builds an authentic cache from an isolated source snapshot using G1's unchanged saved manifests: Cargo.toml SHA256 `69d61b92f24fe9ac7115ca4f0e8f747b56636d8b0da6ac97a2f1c201551500d3`, Cargo.lock `ac6810c1e6f9f134f1b5ba8cb91ba81663fbd865af9c3608ce2d980e7e1dc710`, with `CARGO_INCREMENTAL=0` and a locked build. Record the build command, toolchain and resulting dependency fingerprint. G2 gets an isolated input directory `v2-g2`, a new `bin-g2` snapshot and separate output `gui-g2`; G1's prepared metadata, `bin-g`, raw outcomes, ledgers and registrations stay unchanged. Reuse the **identical optimized server bytes** (SHA256 `97823a5eb6d1ea54568a0aa3b67fe73cce5aa75c4f710b7972899fbaf97ed544`, `fast-release`, opt-level `s`) with recorded copy provenance and fresh build metadata. Do not rebuild or modify the engine. Validate the fresh grading cache and sanity verdicts before calls; record any material problem before affected runs.

**Operational limits and errors.** Keep the **$3 per-run cap**, **6 GiB disk floor**, **25-minute timeout** and **concurrency 4**. Carry the original ledger's **$5.1926128** against the existing **$150** operational guard by setting G2's remaining budget to **$144.8073872**, including its smoke. No overall spending cap is introduced. The reviewed G1-4 guard stands: quota/service denial or unbilled/empty infrastructure attempts stop scheduling and stay in raw records; no performance analysis silently drops them. Ordinary paid task failures, errors, cap exhaustion and timeouts keep their reached steps/cost and fail their grade, as G1 registered. No automatic retries or forced reruns.

**Preflight and smoke.** Obtain the narrow restart audit's go-ahead after checking the cache fingerprint, all preserved pins and provenance. Run the same eight all-arm smoke cells (tasks `loc-agent-env,e2-ho-etag-commas`, seed 99), excluded from analysis; require nonempty billed outputs and correct model/harness/MCP connections before the main batch. New G2 deviations must be registered before affected calls. Preserve a concrete incomplete record if an external limit prevents completion.

```sh
G2_FROM="$HOME/Library/Caches/pandacode-bench/v2-g2"
G2_OUT="$HOME/Library/Caches/pandacode-bench/gui-g2"
node scripts/agent-bench/gui.mjs --prepare --from "$G2_FROM" --out "$G2_OUT" --snapshot bin-g2
node scripts/agent-bench/gui.mjs --smoke --batch G2 --from "$G2_FROM" --out "$G2_OUT" --snapshot bin-g2 --arm PLAIN,T3,PANDA,PANDA_W --tasks loc-agent-env,e2-ho-etag-commas --total-budget-usd 144.8073872
node scripts/agent-bench/gui.mjs --batch G2 --from "$G2_FROM" --out "$G2_OUT" --snapshot bin-g2 --batch-seed 877740526 --arm PLAIN,T3,PANDA,PANDA_W --concurrency 4 --total-budget-usd 144.8073872
node scripts/agent-bench/gui.mjs --analyze --batch G2 --out "$G2_OUT" --arm PLAIN,T3,PANDA,PANDA_W --summary scripts/agent-bench/results/gui-G2.json --csv scripts/agent-bench/results/runs/gui-G2.csv
```
<!-- /prereg:G2 -->

<!-- deviation:G1-5 -->
**G1-5** (2026-11-08, maintenance only; no new G1 calls). Release G1-4's effective `gui.mjs` file pin so the same runner can read G2's explicit private-cache metadata. The new cache routing is used only by the separately registered G2 batch. Original G1 registrations, historical runner hashes, prepared inputs, all 21 run records and partial artifacts remain unchanged. This does not resume G1 or pool its outcomes into G2.
<!-- /deviation:G1-5 -->

<!-- deviation:G2-1 -->
**G2-1** (2026-11-08, before any G2 model call). **Pin a private grading cache.** An unrelated build changed the shared target immediately after the first rebuild completed (2,582 dependency artifacts became 2,898). That shared copy is not used by G2 and no unrelated process or artifact was stopped or removed. A new cold build in the builder's own isolated target produced the authentic private cache below.

- **Provenance:** isolated source based on HEAD `df884aa0d347a00e7407bedbd46c6f7ee69342e3`, 335 Rust/fixture files with provenance digest `94fe8e9ca71592b9cee81d06ee258f3e882a73f355e936646c842c02c1fc7b3c`, plus the unchanged embedded `md4c.js` (`0d5d22df50a4a3f5a27d750d332181943318e6d5bf9c2724d95549af73b6a7ec`). Both G1 saved manifest hashes remain unchanged. Command: `CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=<private>/target cargo test --locked --lib --no-run`, default test profile/features, rustc 1.93.0 (`254b59607`), cargo 1.93.0 (`083ac5135`), aarch64-apple-darwin, LLVM 21.1.8; Rust/profile/compiler overrides unset. Cold build passed in 83 seconds; the focused `only_explore_and_change_tracking_skip_tool_search` test passed and reused dependencies. The initial isolated source copy needed the existing embedded asset copied in before building; no project source changed.
- **Frozen dependency identity:** **2,582 artifacts**, SHA256 **`63d2a07fb24d993801a8e00c71792752f05633937c32d5f0c3d87b2e2fc296c3`**, unchanged before/after focused verification. The private path and complete build evidence stay in local `bin-g2/meta.json`/provenance; no personal path is committed. Keep this original private cache out of all subsequent builds. Disposable grading clones are writable. Removing the builder's own workspace-crate outputs, which `depsFingerprint` already excludes and each run rebuilds, does not change this dependency identity.
- **Minimal runner change:** `snapshotBuild` can record an explicit debug-cache path as `build.target`; `assertBuild` fingerprints that path and every `cloneTarget` caller (GUI, ordinary runner, sanity and saver) copies the same source. Omitted metadata keeps the old shared-path default. The actual clone/drift/default-metadata regression passed after first failing without the change. The source path is not passed to agents; they receive only their disposable target path. G2's commands and all treatment/model/task/gate/budget settings remain unchanged.
- Fresh Rust sanity must exercise all seven registered Rust edit tasks, including their baseline, stub, fixed and suite paths, against disposable clones before paid smoke. Private-cache admission and all builds retain the 6 GiB floor. The original G1 data, snapshot and partial outputs stay unchanged; G1-5 releases only its effective runner-file pin. This entry supersedes G2's runner pin and pins the reviewed helpers/callers too. All analysis code and statistical rules remain as registered.
<!-- /deviation:G2-1 -->

## G2 preparation and runtime status

G2 is registered and prepared with the byte-identical pinned harness/server, unchanged launch texts/catalogs and the authentic private dependency fingerprint above. Preparation recorded **94 benchmark unit tests** and **13 non-Rust edit sanity checks** passed. After the G2-2 repair, all **seven Rust task discriminations completed** and received independent smoke-only GO. The once-only smoke invocation then stopped on an external identity-verification denial: **four invalid attempts, four unstarted cells, zero valid billed smoke runs, 0/480 main runs and $0 new spend**. The detailed preparation and runtime history below is preserved; the current smoke result is recorded at the end.

The builder removed only its own excluded workspace-crate outputs (18 files, 654,057,472 allocated bytes); dependency identity and manifest hashes stayed unchanged. No other task's files or process was touched. The bounded foreground capacity wait completed from **2026-11-08 10:25:09 UTC to 10:45:09 UTC**, sampling every 30 seconds. It **expired after 1,200 seconds** without observing the 7.5 GiB admission threshold (exit 75); its last reading was **4.591 GiB**. The private cache and current launch-text pins were verified again afterward. No benchmark process remains running.

The sanitized [preflight status](../scripts/agent-bench/results/gui-G2.preflight.json) records the review gate, four retained invalid smoke attempts and four unstarted smoke cells. The [G2 main run table](../scripts/agent-bench/results/runs/gui-G2-preflight.csv) remains empty. **G2 is blocked by external service identity verification; main is NO-GO.** Nonempty billed eight-cell smoke evidence, independent main approval, the registered 480-run batch and complete analysis remain outstanding. No performance or statistical conclusion is available. G1's separate partial artifacts and $5.1926128 ledger remain preserved.

Verification commands run during preparation, before the runtime retry below (all model-free):

```sh
node --test --test-reporter=spec scripts/agent-bench/*.test.mjs
"$HOME/Library/Caches/pandacode-bench/v2/bin-g/explore-serve" providers::mcp_host::tests::bench_ --nocapture
node scripts/agent-bench/run.mjs --sanity --edit-v2 --snapshot bin-g2 --out "$HOME/Library/Caches/pandacode-bench/v2-g2" --tasks edit-appimage-x11,edit-sidebar-sections,edit-projects-added-order,edit-npx-platforms,e2-ho-accepts-exact,e2-ho-etag-commas,e2-ho-timing-quotes,e2-ho-timing-precision,e2-ho-basepath-regex,e2-ho-clone-void,e2-ho-combine-some,e2-ho-accept-negative-q,e2-linux-arm64-target
node --test --test-name-pattern 'held-out tasks are well formed' scripts/agent-bench/check.test.mjs
```

Preparation results: 94/94 benchmark tests, 3/3 optimized catalog tests, 13/13 selected sanity verdicts `ok`, and the final registration check 1/1. One-off assertions also verified the live HTTP MCP path, sanitized JSON/CSV counts, original G1 counts/ledger, current launch hashes and the private-cache fingerprint. The 20-minute admission monitor exited 75, as recorded above; no application typecheck, browser suite or full registered model comparison is claimed.

### Runtime retry on 2026-11-08

At **11:31:14 UTC**, actual free space was **8.058 GiB**, above the 7.5 GiB admission threshold. Fresh assertions passed for the saved manifests, explicit private cache (`63d2a07f…` / 2,582 artifacts), four pinned runner/helper files and the optimized server binary. The existing sanity runner began the seven selected Rust tasks sequentially on disposable clones. Its first task (`edit-recipe-harnesses`) was stopped with exit **143 before any completed verdict**: the reviewer identified that `sanity.json` omits the suite command kind/exit, so an empty failure list cannot establish a valid suite run. No Rust sanity pass is claimed from that interrupted attempt. Its own scratch directory was removed and its child processes were confirmed stopped; the private original and unrelated builds were untouched.

A local Cargo observer outside the checkout now retains each command's argv, working directory, disposable target, separate stdout/stderr and exit status while forwarding the same command/environment to the installed Cargo. Its `cargo --version` self-check passed (1.93.0), and the runtime reviewer accepted the observer. No source, treatment, task or preregistration changed. Remaining sanity tasks are invoked individually, with a fresh cache assertion and 7.5 GiB admission check before each. The guarded restart declined to start at **11:35:21 UTC**, with **7.346 GiB** free.

The bounded foreground recovery watch ran **11:36:30–11:41:30 UTC** (300.523 seconds, 21 samples at 15-second intervals) and exited **75** without readmission. Samples ranged from **2.974 to 7.382 GiB**; the final sample was **3.526 GiB**. Read-only process inspection showed concurrent Cargo builds in a sibling checkout; none was stopped or modified. Local evidence is retained under the benchmark cache's `v2-g2/sanity-runtime-20261108T1134Z/` directory. No monitor, build or harness remains running from this retry.

Fresh assertions also confirmed the original **G1 21 main + 8 smoke runs / $5.1926128 ledger**, and **G2 0 main + 0 smoke / $0**. The preflight JSON records this retry and preserves the previous 20-minute wait separately; the G2 CSV remains empty. The accepted 94 benchmark tests, three catalog checks and 13 non-Rust sanity verdicts were not repeated. A final registration-integrity check and sanitized artifact/pin assertions were run after this status update. **Seven Rust sanity verdicts, eight reviewed smoke runs, all 480 main runs and complete analysis remain pending because of external disk capacity.** No performance conclusion is available.

At **11:59:01 UTC**, the follow-up after the queued cache-cleanup attempt again declined admission: actual free space was **1.248 GiB**. Fresh `assertBuild`, the explicit private-cache fingerprint and current source/binary/launch pins all passed; the interrupted scratch remained absent. The cleaner reported skipping the SSH cache because it was active, and read-only process inspection confirmed Cargo running in that sibling checkout. No new Rust task or model call was started, and no additional wait, observer installation, preparation or completed test suite was repeated. The approved observer and all prepared inputs remain available. **The runtime pipeline remains blocked by external shared disk capacity.**


### Runtime resume on 2026-11-09

Fresh checks confirmed the saved manifests, explicit private cache (`63d2a07f…` / 2,582 dependency artifacts), four pinned runner/helper files, optimized server, harness 2.1.317 and all six live launch hashes. Admission for the first individual Rust task observed **65.752 GiB** free, above 7.5 GiB; the existing 6 GiB floor remained active. The accepted Cargo observer was reused unchanged, with an isolated disposable target. No preparation, cache build, paid call or previously completed test suite was repeated.

The exact invocation was `node scripts/agent-bench/run.mjs --sanity --edit-v2 --snapshot bin-g2 --out <benchmark-cache>/v2-g2 --tasks edit-recipe-harnesses`. Its baseline, stub and fixed commands were each `cargo test --lib recipes::`; the registered suite was `cargo test --lib providers::`. **All four Cargo commands exited 101 before tests ran**, because `libsqlite3-sys` 0.36.0 could not read `target/debug/build/libsqlite3-sys-c6bc0fb34594472f/out/bindgen.rs`. Read-only inspection confirmed that generated file is also absent from the original private cache. The dependency-name fingerprint and `assertBuild` still pass; they do not establish generated build-output completeness. The sanity runner itself exited **0** and recorded **EXCLUDE** (`parent`, `stub`, `fix` all `build`); the evidence-checking controller rejected that result with exit **1**. No valid Rust discrimination verdict or suite result is claimed.

Execution stopped at this issue. The remaining six Rust tasks were not started, and none was rerun or changed. Actual argv, working directory, disposable target, stdout, stderr and exit status remain in local `v2-g2/sanity-runtime-20261108T1134Z/`, under observer IDs `1794189983315-70369` (baseline), `1794189987890-70828` (stub), `1794189989182-71301` (fixed) and `1794189989512-71342` (suite). The task manifest is `resume-20261109T0205Z.edit-recipe-harnesses.result.json`; matching preflight/postflight manifests retain preservation evidence.

Postflight verified **91 protected file hashes unchanged**, including G1 raw records, its **21 main + 8 smoke / $5.1926128 ledger**, saved metadata, snapshots and registrations. Current source/server/manifest/launch pins and the private dependency fingerprint passed again. Free space remained **65.380 GiB**; the disposable target was removed by the sanity runner, and no runtime process remains. The original private cache and observer were preserved. **All seven Rust verdicts remain pending because of the build-output blocker.** Repair exceeds this phase's results/docs scope; eight paid smoke runs and the 480-run main batch still require their separate review gates. G2 remains at **0 smoke, 0/480 main and $0 new model spend**, with no performance conclusion.


<!-- deviation:G2-2 -->
**G2-2** (2026-11-09, before any G2 model call). **Regenerate dependency build outputs in disposable clones.** The frozen private cache lacks SQLite `build/out/bindgen.rs` despite retaining successful build-script execution fingerprints. `depsFingerprint` is a dependency-name identity only, not proof of generated-output completeness or content. Preserve the original `63d2a07fb24d993801a8e00c71792752f05633937c32d5f0c3d87b2e2fc296c3` / 2,582-artifact cache and metadata unchanged.

- `cloneTarget` now removes only `debug/.fingerprint/*/run-build-script-*` execution files from its disposable copy, in addition to its existing incremental cleanup. Compiled build scripts and dependencies remain cached; authentic pinned build scripts rerun at the disposable `OUT_DIR`. The frozen original is never repaired or rebuilt. This entry supersedes G2-1 and re-pins all its task/GUI/helper/caller files plus `runner.test.mjs`; G1-5's effective files remain empty, so no G1 pin release is needed.
- The actual offline Cargo regression first failed with exit 101 for a missing generated include, then passed with regeneration; the implementation worker reported all 20 runner tests passed. The separate retained real-cache experiment (`src-tauri/target/pandacode-g2-regeneration-evidence/`) ran `cargo test --locked --lib --no-run`: exit 0 in 170.54 seconds after removing 130 execution files. SQLite bindings regenerated with SHA256 `cf53846904130e42d81072cd63302c6d9261f45a9842c3a4093235c072398528`, matching the bundled registry bindings; the library test executable compiled and linked. All 5,905 inventoried original source/cache hashes remained unchanged. Native output paths relocated; one orphaned, unused old workspace-crate `root-output` record is documented in the local report. This establishes compile/link recovery only, not a test or sanity verdict.
- Keep all failed infrastructure-attempt records, including the earlier recorded EXCLUDE, without treating them as a task-performance exclusion or pass. All seven Rust tasks still require actual baseline/stub/fixed/suite evidence. Independent smoke approval must follow valid sanity results; eight all-arm smoke runs require review before main approval. No paid approval is granted here.
- No new cache identity or comparison batch: preserve the manifests, server/harness, launch texts, tasks, design, seed 877740526, $3 run cap, 6 GiB floor, 7.5 GiB admission, concurrency 4, 25-minute timeout and $144.8073872 remaining operational budget. Preserve every original registration and G1's separate 21 main + 8 smoke / $5.1926128 raw records and ledger. G2 remains at 0 smoke, 0/480 main and $0; analysis rules are unchanged.
<!-- /deviation:G2-2 -->

### Current runtime status after G2-2

The repaired sanity-only phase ran **2026-11-09 02:25:57–02:42:20 UTC**. **All seven Rust task discriminations are complete**, alongside the 13 previously accepted non-Rust verdicts; none of those 13 was rerun. All 22 actual Cargo commands have retained argv, working directory, disposable target, stdout/stderr and exit status. The six registered suites executed: five passed, while the pnpm task's provider suite ended with two assertion failures. No task was retried, excluded or patched. The earlier capacity, interruption and build-output records above remain historical evidence.

Each task was invoked individually and sequentially with the unchanged command:

```sh
node scripts/agent-bench/run.mjs --sanity --edit-v2 --snapshot bin-g2 --out <benchmark-cache>/v2-g2 --tasks <task-id>
```

The Cargo commands below are `cargo test --lib <filter>`. Exit 101 in the first two baselines is the expected missing-symbol/visibility failure covered by each registered stub; their stubs then ran and failed assertions. Every other baseline failed assertions. Tasks without registered stubs use baseline assertions directly; draft-rank-undo has no registered suite.

| Task | Test filter | Baseline exit | Stub exit | Fixed exit / tests passed | Registered suite filter / exit / outcome |
| --- | --- | --- | --- | --- | --- |
| `edit-recipe-harnesses` | `recipes::` | 101 (private `PROVIDERS`) | 101 (2 assertions) | 0 / 7 | `providers::` / 0 / 335 passed, 17 ignored |
| `edit-connect-secrets` | `remote::secrets::` | 101 (missing `LOCK`) | 101 (3 assertions) | 0 / 4 | `remote::` / 0 / 49 passed |
| `e2-draft-rank-undo` | `storage::` | 101 (2 assertions) | Not registered | 0 / 60, 1 ignored | Not registered |
| `e2-boat-trial-ttl` | `cloud::boat::` | 101 (1 assertion) | Not registered | 0 / 4 | `cloud::` / 0 / 135 passed, 15 ignored |
| `e2-pnpm-global-bin` | `providers::launch::` | 101 (2 assertions) | Not registered | 0 / 21 | `providers::` / **101** / 404 passed, **2 failed**, 23 ignored |
| `e2-opencode-cache-pin` | `cloud_agents::setup::` | 101 (1 assertion) | Not registered | 0 / 8 | `cloud_agents::` / 0 / 28 passed |
| `e2-do-ssh-key` | `cloud::digitalocean::` | 101 (2 assertions) | Not registered | 0 / 9, 1 ignored | `cloud::` / 0 / 138 passed, 15 ignored |

The pnpm provider-suite failures are `agent_usage_providers::tests::antigravity_old_cli_never_gets_a_prompt_and_new_cli_uses_exact_report_command` (reported status `unavailable` versus expected `unsupported`) and `agent_usage_providers::tests::antigravity_report_timeout_output_limit_and_stderr_are_bounded` (report did not run after the version check). Their actual output is retained; no clean provider-suite pass is claimed for this task.

Local evidence is under `v2-g2/sanity-runtime-20261108T1134Z/`: `repaired-20261109T0224Z.<task-id>.{preflight,start,result}.json`, per-task runner stdout/stderr, and each result's observer-ID stdout/stderr and command records. The phase preservation manifests are `repaired-20261109T0224Z.initial.json` and `repaired-20261109T0224Z.postflight.json`; the sanitized [preflight status](../scripts/agent-bench/results/gui-G2.preflight.json) includes the per-task command table. All seven sanity runners and evidence controllers exited 0; those exits supplement the actual command/test evidence above.

Every task passed fresh G2-2 source/task/analysis, registration, manifest, server, harness, live launch-text and private-cache checks before admission. Admissions ranged from **60.127 to 60.926 GiB**, above 7.5 GiB, with the unchanged 6 GiB floor active. Final postflight at **02:42:34 UTC** passed: all **5,905 original source/cache content hashes** and **97 protected file hashes** stayed unchanged, including G1's **21 main + 8 smoke / $5.1926128 ledger**, saved metadata, snapshots and registrations. The original private target remains unchanged at `63d2a07f…` / 2,582 artifacts. Each owned disposable target was removed; no runtime process remains. Final free space was **60.324 GiB**.

Status immediately before the smoke-only review was **`sanity-complete-pending-review`**. The accepted source-repair review is GO; the completed runtime evidence is ready for independent review and a separate smoke-only GO. **G2 remains at 0 smoke, 0/480 main and $0 new model spend.** Eight smoke runs, their main-run approval, the 480-run batch and complete analysis remain pending. No performance or statistical conclusion is available.

### Smoke-only review gate

The independent runtime reviewer (`78ad274c-c267-4a0d-b0ed-2d5fc45770f2`) completed `g22-final-seven-runtime-review` with **“SMOKE-ONLY GO for registered eight all-arm G2 smoke runs; MAIN NO GO pending smoke review.”** The architect read that final response and reviewer message **5901**, and delivered the explicit decision to the smoke worker in message **5905**. This satisfies the runtime review gate; the preflight now records smoke approval and no pending runtime review. Fresh input/preservation checks and admission precede the once-only eight-cell smoke. Main remains unapproved.

### Current smoke result: identity-verification guard stop

The explicit smoke-only approval above was recorded before calls. Fresh preflight passed at **2026-11-09 02:51:10 UTC**, with **60.325 GiB** free, above the 7.5 GiB admission threshold. Effective source/task/analysis, registration, six live launch-text, saved manifest, server and harness pins matched. All 5,905 original source/cache content hashes, 97 protected hashes, G1 raw records/ledger and 166 historical evidence files matched. The frozen private cache remained `63d2a07f…` / 2,582 artifacts. No preparation, build, sanity or test suite was repeated.

The registered invocation ran once, **02:51:30–02:51:35 UTC**, with its existing seed 99, concurrency 4, $3 per-run cap, 25-minute timeout, 6 GiB floor and $144.8073872 remaining budget:

```sh
node scripts/agent-bench/gui.mjs --smoke --batch G2 --from <benchmark-cache>/v2-g2 --out <benchmark-cache>/gui-g2 --snapshot bin-g2 --arm PLAIN,T3,PANDA,PANDA_W --tasks loc-agent-env,e2-ho-etag-commas --total-budget-usd 144.8073872
```

The first four concurrent cells were the four arms of `e2-ho-etag-commas`. Every attempt returned **“API Error: 400 Identity verification is required to continue.”**, child exit **1**, **$0 billed**, **zero output tokens** and synthetic error text only. The runner's registered **missing-or-zero-billing** guard stopped scheduling and exited **3**. The four `loc-agent-env` cells were never started. The apparent one step per attempt is the harness's synthetic error turn, not model inference. No grade was produced; no paid task failure or performance result is claimed.

| Task / seed | Arm | Attempt status | Resolved model / harness | MCP connection | Output tokens / billed USD |
| --- | --- | --- | --- | --- | --- |
| `e2-ho-etag-commas` / 99 | PLAIN | Once; identity verification denied | `claude-sonnet-5-5` / 2.1.317 | None, as registered | 0 / $0 |
| `e2-ho-etag-commas` / 99 | T3 | Once; identity verification denied | `claude-sonnet-5-5` / 2.1.317 | `t3-code`: connected | 0 / $0 |
| `e2-ho-etag-commas` / 99 | PANDA | Once; identity verification denied | `claude-sonnet-5-5` / 2.1.317 | `pandacode_architect`: connected | 0 / $0 |
| `e2-ho-etag-commas` / 99 | PANDA_W | Once; identity verification denied | `claude-sonnet-5-5` / 2.1.317 | `pandacode_architect`: connected | 0 / $0 |
| `loc-agent-env` / 99 | PLAIN | Unstarted | — | — | — |
| `loc-agent-env` / 99 | T3 | Unstarted | — | — | — |
| `loc-agent-env` / 99 | PANDA | Unstarted | — | — | — |
| `loc-agent-env` / 99 | PANDA_W | Unstarted | — | — | — |

The coverage invariant is **8 expected = 4 once-only invalid attempts + 4 unstarted cells; 0 valid billed smoke runs**. All four attempts retain raw `stream.jsonl` and `run.json` records in local `gui-g2/runs/smoke-G2/`, including actual model/harness/MCP initialization, API error and billing. `gui-g2/ledger.jsonl` retains exactly four starts and four ends, $0 total, with no open or interrupted attempt. No attempt was retried, forced, deleted or silently excluded. The raw report retains the guard reason and four remaining cells. The actual invocation, separate stdout/stderr, exit, preflight/postflight hashes and eight-cell inventory are retained in `gui-g2/smoke-runtime-20261109T0250Z/` (`invocation.json`, `stdout.log`, `stderr.log`, `exit.json`, `preflight.json`, `postflight.json`, `audit.json`).

Postflight at **02:51:52 UTC** passed the same cache, pins, 5,905 original and 97 protected hashes, G1 preservation and 166 historical evidence hashes; free space was **60.000 GiB**. The coverage/ledger/raw-output audit passed. Owned scratch directories were removed, the recorded child list is empty and the runner exited; no runtime process remains. G1 remains **21 main + 8 smoke / $5.1926128**. G2 remains **0/480 main, four invalid smoke attempts, zero valid billed smoke runs and $0 new spend**; the remaining operational budget stays **$144.8073872**. **Main is NO-GO.** Further smoke requires resolution of the external verification block and explicit reviewed disposition for the retained invalid attempts; no further call is authorized by this phase. No performance analysis was run.


<!-- deviation:G2-3 -->
**G2-3** (2026-11-09, before any recovery call). **Prospective infrastructure recovery; execution NO-GO.** Protocol reviewer message 5937 accepts this design conditionally. Account-owner identity-resolution status is awaiting confirmation; no execution approval is granted. The original smoke-G2 wave retains four API 400 identity-verification-denied attempts, zero output tokens, $0, no grades and four unstarted cells. Preserve every old raw run, stream, report, invocation and historical record byte-for-byte. These are infrastructure attempts, not performance exclusions.

- Permit one deliberate full eight-cell recovery smoke under the fresh label **G2-recovery-1**, two tasks × four arms, seed/order **99**. Smoke bypasses pinnedSeed, so this label is explicitly bound to every unchanged G2-2 effective source/task pin (tasks-gui.json, tasks.json, tasks-edit-v2.json, gui.mjs, lib.mjs, run.mjs, saver.mjs, runner.test.mjs) and its three analysis pins. G2-3 supersedes G2-2 with all eight pins repeated, not released. Preserve claude-sonnet-5-5, harness 2.1.317, server, launch texts/catalogs, manifests, snapshot bin-g2 and frozen private cache 63d2a07fb24d993801a8e00c71792752f05633937c32d5f0c3d87b2e2fc296c3 / 2,582 artifacts; no source, build, cache, task or treatment changes.
- Future command below is **NOT RUN**. Same FROM and OUT retain the shared global ledger: **144.8073872 USD is the cumulative G2 threshold**, including old attempts, recovery and future main. After smoke spend S the remaining allowance is 144.8073872 − S; the main CLI threshold stays 144.8073872, with no reset or double subtraction. G1 remains separate (21 main + 8 smoke / $5.1926128).

```sh
node scripts/agent-bench/gui.mjs --smoke --batch G2-recovery-1 --from <benchmark-cache>/v2-g2 --out <benchmark-cache>/gui-g2 --snapshot bin-g2 --arm PLAIN,T3,PANDA,PANDA_W --tasks loc-agent-env,e2-ho-etag-commas --concurrency 4 --run-cap-usd 3 --run-timeout-min 25 --min-free-gib 6 --total-budget-usd 144.8073872
```

- Before requests require factual account-owner confirmation that identity verification is resolved for the account used by the pinned harness, acceptance of this registered disposition, and **new explicit smoke-only approval after registration**. Recheck frozen pins and preservation, fresh admission ≥7.5 GiB with the 6 GiB floor, no live OUT lease/runner/owned children or open ledger attempts, and wholly absent runs/smoke-G2-recovery-1 immediately before launch. Never use --force, delete old or partial directories, override skip behavior, reset budget, change accounts/secrets, or use gui --register with the recovery label as a substitute. No preparation/build/sanity reruns absent drift.
- This is no automatic retry. Any new denial, missing/zero billing, empty output or model/harness/MCP mismatch stops scheduling under the same guards; retain attempted, inflight and unstarted dispositions. No further recovery namespace is authorized automatically. Ordinary paid task errors, timeouts and cap failures retain registered treatment, with no outcome exclusion or tuning. Both smoke waves remain outside main statistics. Acceptance requires all eight nonempty billed outputs with correct model/harness/MCP for every arm, including PANDA_W, followed by independent smoke review and separate main GO.
- Main remains **--batch G2**, 480 runs, seeds 1/2/3 and order seed **877740526**, with unchanged registered analysis and design. No main data exists; no new comparison batch is required. All historical marked sections and registry lines remain unchanged. The prior identity-blocked status and counts remain evidence, not a completed smoke.
<!-- /deviation:G2-3 -->

### G2-recovery-1 preflight: admission refused, no call

After the account owner confirmed identity verification and the architect granted a new smoke-only GO, the fresh preflight ran at **2026-11-10T03:56:05Z** and **failed admission**: **4.145 GiB** free on the cache volume, below both the 7.5 GiB fresh admission and the 6 GiB floor. The run aborted before any service call, as registered. The recorded G2-recovery-1 command was **not executed**: no runner, no child, no ledger line, no `runs/smoke-G2-recovery-1/`, $0 spend. Checks that passed: old 935-byte ledger unchanged (`321046c4…`), no live runner lease (pid 67032 dead, `pids.json` empty), recovery directory absent, old `smoke-G2` evidence present. Pin and hash checks were not repeated because admission had already failed. No cache cleanup, deletion or retry was done. G2 stays at 0/480 main, 0 valid smoke runs, $144.8073872 remaining. The recovery needs about 3.3 GiB more free disk, then a new preflight.

### G2-recovery-1 preflight retry: protected evidence missing, no call

After disk recovered (65 GiB free), the second fresh preflight ran at **2026-11-10T09:46Z** (evidence `gui-g2/recovery-runtime-20261110T0946Z/`) and **failed before any service call**. The whole `src-tauri/target/` directory is gone, including `pandacode-g2-regeneration-evidence/`: `protected-before.json` (the 5,905 original content hashes) and 8 other files of that record are missing, so the original-hash check cannot run and 9 of 166 historical evidence files fail preservation. The recorded G2-recovery-1 command was **not executed**: no runner, no ledger line, no `runs/smoke-G2-recovery-1/`, $0 spend.

Checks that passed before the abort: admission (65 GiB ≥ 7.5 GiB, floor 6), old 935-byte ledger unchanged (`321046c4…`), old `smoke-G2` report (`f52c721a…`) present, no live runner (pid 67032 dead, `pids.json` empty), recovery directory absent, frozen private cache `63d2a07f…` / 2,582 files. All 97 protected files are present; 96 match, and the one difference is `preregistrations.jsonl`, which grew only by the registered G2-3 line (its prefix still hashes to the recorded value). Nothing was restored, rebuilt, deleted or retried. G2 stays at 0/480 main, 0 valid smoke runs, $144.8073872 remaining. The recovery needs an architect decision on the deleted regeneration evidence (restore it or re-baseline under a registered disposition), then a new full preflight.

<!-- deviation:G2-4 -->
**G2-4** (2026-11-10, before any recovery call). **Restore deleted regeneration evidence from byte-identical copies.** The architect chose restore, not re-baseline. The 2026-11-10T09:46Z preflight found `src-tauri/target/pandacode-g2-regeneration-evidence/` deleted with the whole `src-tauri/target/`. Byte-identical copies of all nine files survived outside the repository: eight in the regeneration experiment's evidence directory under `/private/tmp` and the experiment script, recorded as `experiment.py`. They were copied (never moved) with original names into the durable `gui-g2/restored-regeneration-evidence-20261110/`. All nine SHA-256 values equal the 166-entry `historicalEvidenceHashes` in `gui-g2/smoke-runtime-20261109T0250Z/preflight.json`, and the restored `protected-before.json` re-hashes **5,905/5,905** against the current files. The frozen cache `63d2a07f…` was also backed up read-only to `gui-g2/frozen-cache-backup-20261110/` (all file hashes identical to the original); no benchmark path points at the backup, and the original is unchanged.

- The preflight reads the nine files at the restored location; every recorded hash is unchanged. No original evidence is recreated in `src-tauri/target/`, rebuilt or re-baselined.
- `preregistrations.jsonl` is checked by its recorded 28-line prefix (`b8647cdc…`) plus the registered G2-3 and G2-4 rows, not by whole-file hash.
- The `recoveryPreflight20261110` "checks that passed" are **unverified**: the check script aborted at line 18 on the missing `protected-before.json` and kept no stdout. They come from manual checks, not from the script. A fixed copy of the check (the old one kept) records full stdout and stderr.
- Nothing else changes. G2-4 supersedes G2-3 and repeats its same eight source/task pins and three analysis pins. Tasks, arms, seed **99**, cumulative budget **144.8073872 USD**, the recorded command and label **G2-recovery-1** are unchanged; main stays **--batch G2**, 480 runs, order seed 877740526. All G2-3 prerequisites, guards and stop rules still apply, including a fresh full preflight right before the once-only recorded command. This registration authorizes no call.
<!-- /deviation:G2-4 -->

### G2-recovery-1 smoke: eight billed runs, pending review

After the account owner confirmed identity verification and the architect granted a smoke-only GO, a fresh copy of the fixed G2-4 check ran at **2026-11-10T10:06Z** in a new evidence directory and passed **27/27**: 5,905 original content hashes (restored `protected-before.json`), 97 protected hashes (`preregistrations.jsonl` by its recorded prefix plus the registered G2-3/G2-4 rows), all 30 registration sections and pins, frozen cache `63d2a07f…` / 2,582 files, model `claude-sonnet-5-5`, harness 2.1.317, launch texts, 166 historical evidence files (the nine regeneration files at the restored location), G1 at 21 main + 8 smoke / $5.1926128, the old 935-byte ledger and `smoke-G2` evidence, no live runner, an absent recovery directory, empty scratch and **67.46 GiB** free (≥ 7.5 GiB admission, 6 GiB floor).

The recorded G2-3 command then ran **once**, **10:06:57–10:12:00 UTC**, and exited **0**:

```sh
node scripts/agent-bench/gui.mjs --smoke --batch G2-recovery-1 --from <benchmark-cache>/v2-g2 --out <benchmark-cache>/gui-g2 --snapshot bin-g2 --arm PLAIN,T3,PANDA,PANDA_W --tasks loc-agent-env,e2-ho-etag-commas --concurrency 4 --run-cap-usd 3 --run-timeout-min 25 --min-free-gib 6 --total-budget-usd 144.8073872
```

No guard fired (`stoppedBy: null`, 8 ran, none remaining). Every cell ran once, with no retry, denial, API 400, timeout or cap hit. Every cell billed, produced real (non-synthetic) model output, and resolved the registered model, harness and MCP connection:

| Task / seed | Arm | Model / harness | MCP connection | Steps | Output tokens | Billed USD | Runner `ok` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `e2-ho-etag-commas` / 99 | PLAIN | `claude-sonnet-5-5` / 2.1.317 | None, as registered | 3 | 1,152 | 0.0466848 | true |
| `e2-ho-etag-commas` / 99 | T3 | `claude-sonnet-5-5` / 2.1.317 | `t3-code`: connected | 4 | 1,709 | 0.1173765 | true |
| `e2-ho-etag-commas` / 99 | PANDA | `claude-sonnet-5-5` / 2.1.317 | `pandacode_architect`: connected | 4 | 1,213 | 0.1032189 | true |
| `e2-ho-etag-commas` / 99 | PANDA_W | `claude-sonnet-5-5` / 2.1.317 | `pandacode_architect`: connected | 3 | 693 | 0.0503483 | true |
| `loc-agent-env` / 99 | PLAIN | `claude-sonnet-5-5` / 2.1.317 | None, as registered | 7 | 3,450 | 0.3827931 | true |
| `loc-agent-env` / 99 | T3 | `claude-sonnet-5-5` / 2.1.317 | `t3-code`: connected | 11 | 5,359 | 0.5294963 | true |
| `loc-agent-env` / 99 | PANDA | `claude-sonnet-5-5` / 2.1.317 | `pandacode_architect`: connected | 4 | 2,493 | 0.2968423 | true |
| `loc-agent-env` / 99 | PANDA_W | `claude-sonnet-5-5` / 2.1.317 | `pandacode_architect`: connected | 7 | 3,593 | 0.3576285 | true |

Recovery spend is **$1.8843887**. The shared `gui-g2/ledger.jsonl` keeps its original 935-byte prefix (`321046c4…`) and adds exactly eight starts and eight matching ends for `smoke-G2-recovery-1`, with no open or interrupted attempt; each end equals its run's billing. The cumulative G2 ledger is $1.8843887, so the remaining G2 allowance is **$142.9229985** of the 144.8073872 threshold (no reset, no double subtraction). "Runner `ok`" is what the smoke runner printed; no grading or comparison was done here.

Postflight at **10:12:14 UTC** passed **24/24**: the same 5,905 original and 97 protected hashes, pins, frozen cache, 166 historical files, G1, and every file of `runs/smoke-G2/` and `smoke-runtime-20261109T0250Z/` byte-identical to the preflight; free space 67.11 GiB. The runner exited, `pids.json` is empty and owned scratch is empty. Raw `run.json` and `stream.jsonl` for all eight cells and `report.json` are in local `gui-g2/runs/smoke-G2-recovery-1/`; the copied check, invocation, stdout, stderr, exit, pre/postflight results and audit are in `gui-g2/recovery-run3-20261110T1006Z/`.

Status: **`smoke-complete-pending-review`**. G2 has **8 valid billed recovery smoke runs** (plus the four retained invalid `smoke-G2` attempts), **0/480 main**, and both smoke waves stay outside main statistics. **Main is NO-GO** until an independent review of these eight runs and a separate main GO.

### G2-recovery-1 smoke review: valid; main NO-GO on account quota

An independent reviewer (worker `92508b7c`) checked the eight `smoke-G2-recovery-1` runs, and the result was then re-checked against the raw `stream.jsonl` files in local `gui-g2/runs/smoke-G2-recovery-1/`. No service or model calls, builds or benchmark runs were made for this review.

**Smoke verdict: VALID.** The argv equals the registered G2-3/G2-4 command. All 8/8 cells billed, and the result costs sum to **$1.8843887**, equal to the eight recovery ledger ends. Every stream resolves model `claude-sonnet-5-5` and harness 2.1.317. Arm isolation matches the registration. The shared ledger keeps its 935-byte prefix (`321046c4…`). There is no contamination: smoke seed 99 runs in its own batch namespace, while main uses seeds 1, 2, 3 with order seed 877740526.

**Main verdict: NO-GO (account quota).** In every stream, the last `rate_limit_event` shows the `seven_day` window at utilization **0.98**, status `allowed_warning`, `overageStatus: rejected` (`out_of_credits`), and a reset at **2026-11-16T01:00Z** (`resetsAt` 1794790800). The main batch's projected cost is about $75–115 (worst case about $130–140). That would exhaust the remaining weekly quota and leave an incomplete batch.

Conditions for a future main GO:

1. Either the reset at 2026-11-16T01:00Z has passed, or the account owner has turned on extra usage.
2. Utilization is confirmed low without a paid call.
3. A fresh preflight passes immediately before the unchanged registered main command (`--batch G2`, 480 runs, order seed 877740526, `--total-budget-usd 144.8073872`).
4. The architect gives a separate main GO.

Status: **`smoke-valid-main-no-go-quota`**. G2 has 8 valid billed recovery smoke runs ($1.8843887), excluded from analysis, and 0/480 main runs.

### Merge maintenance: worker report extraction

<!-- deviation:G2-5 -->
**G2-5** (2026-11-18, maintenance only; no benchmark calls). Merging main removed the worker report's byte-budget clause. `findWorkerReport` now extracts the current wording and still substitutes the default or requested limit in historical inputs. The historical default report still hashes to `dd87a377710ca984afaf4640225b39a6d1f6402c09090e6c2454f4b541dc43f9`; the current report hashes to `953fc360cbe4cd420d7e02fbee23c1e81667b05507bb0ce9ab67abb8345ff732`.

The registration test requires this entry because it checks unsuperseded source hashes. G2-5 supersedes G2-4 to pin the updated `saver.mjs`, repeating the other seven source/task pins and all three analysis pins unchanged. The preceding 30 registration rows and every registered section remain byte-identical, as do historical measurements and their evidence.

Prepared launch texts, metadata, snapshots, seeds and treatment pins are unchanged. Saver's `assertUnchanged` and GUI's `loadMeta` still reject launch-text drift: this parser fix does not make the recorded G2 launches current or authorize a call. Launching with the changed report requires fresh preparation under a separately registered batch; existing evidence must be preserved.
<!-- /deviation:G2-5 -->

### CI maintenance: portable dependency-cache copies

<!-- deviation:G2-6 -->
**G2-6** (2026-11-18, maintenance only; no benchmark calls). Ubuntu CI rejected the macOS-only `cp -c` flag in `cloneTarget`. The shared helper now uses `-c` only on macOS, retaining APFS copy-on-write, and portable `cp -R -p` elsewhere. Each copy has a 20-minute timeout. Copies remain independent, preserve permissions, timestamps and symlink targets, and remove incremental data and build-script execution fingerprints only from the disposable cache. The four callers and dependency-identity checks are unchanged.

The Linux-mode regression rejects non-POSIX copy flags and exercises actual host copying, including paths with spaces, file permissions, file/directory timestamps, relative and dangling symlinks, independent writes, dependency identity and disposable-only cleanup. The existing offline Cargo test continues to check regeneration of missing build outputs without modifying the source cache. This is test proof of the Linux flag path; it does not claim a Linux runtime run or a benchmark measurement.

G2-6 supersedes G2-5 to pin the changed `lib.mjs` and `runner.test.mjs`, repeating its other six source/task pins and all three analysis pins unchanged. The preceding 31 registration rows and every historical registered section remain byte-identical. No historical result, prepared launch text, metadata, snapshot, seed, treatment, budget or launch gate changes. G2-5's launch-text-drift restriction and the separate smoke/main approval gates still apply; this maintenance entry authorizes no model call or batch launch.
<!-- /deviation:G2-6 -->

### CI maintenance: recursive build-script fingerprint cleanup

<!-- deviation:G2-7 -->
**G2-7** (2026-11-18, maintenance only; no benchmark calls). Ubuntu CI uses Cargo's nested build-dir layout (`debug/.fingerprint/<pkg>/<hash>/run-build-script-*`, two levels under `.fingerprint/`), which `cloneTarget`'s one-level directory scan missed, causing `runner.test.mjs`'s cache-regeneration test to fail on `ubuntu-latest`. `cloneTarget` now walks `debug/.fingerprint/` recursively (without following symlinks) and removes any `run-build-script-*` file at any depth in the disposable copy only, handling both flat (`.fingerprint/<pkg>-<hash>/`) and nested (`.fingerprint/<pkg>/<hash>/`) layouts while retaining compiled `build-script-build` artifacts and leaving the source cache untouched.

A new regression test in `runner.test.mjs` exercises both flat and nested `.fingerprint/` layouts and verifies that `run-build-script-*` files are removed only from the disposable copy while `build-script-build` files and the source cache remain intact.

G2-7 supersedes G2-6 to pin the changed `lib.mjs` and `runner.test.mjs`, repeating its other six source/task pins (`tasks-gui.json`, `tasks.json`, `tasks-edit-v2.json`, `gui.mjs`, `run.mjs`, `saver.mjs`) and all three analysis pins unchanged. The preceding 32 registration rows and every historical registered section remain byte-identical. No historical result, prepared launch text, metadata, snapshot, seed, treatment, budget or launch gate changes. G2-5's launch-text-drift restriction and the separate smoke/main approval gates still apply; this maintenance entry authorizes no model call or batch launch.
<!-- /deviation:G2-7 -->

### CI maintenance: build-dir execution fingerprints

<!-- deviation:G2-8 -->
**G2-8** (2026-11-22, maintenance only; no benchmark calls). G2-7's recursive scan covers nested directories beneath `debug/.fingerprint/`, but Cargo 1.99's `-Zbuild-dir-new-layout` actually writes execution fingerprints at `debug/build/<pkg>/<hash>/fingerprint/run-build-script-*`. Its cached execution metadata lives alongside them in `run/{stdout,stderr,root-output,invoked.timestamp}`. A missing generated file alone does not invalidate that successful execution. Local inspection and a dependency-free Cargo 1.99 reproduction confirmed that deleting the execution fingerprints forces regeneration while retaining those metadata files.

`cloneTarget` now also finds `fingerprint/` directories beneath the disposable `debug/build/` and removes their `run-build-script-*` files. It skips `out/`, `run/` and directory symlinks, retaining generated artifacts, compiled build scripts, run metadata and `debug/deps`. The existing legacy `.fingerprint/` cleanup remains. The source cache is never repaired or rebuilt.

The offline Cargo regression explicitly builds both flat and nested layouts, with the unstable-layout opt-in scoped to the dependency-free fixture, and checks missing-output regeneration, dependency identity and byte-identical source cache contents. Synthetic fixtures cover both legacy fingerprint layouts, the actual new build-dir fingerprint location, retained run markers and compiled artifacts, an output subtree containing fingerprint-like names, and a directory symlink back into the source cache. The portable Linux copy-flags regression remains in place.

G2-8 supersedes G2-7 to pin the changed `lib.mjs` and `runner.test.mjs`, repeating its other six source/task pins and all three analysis pins unchanged. The preceding 33 registration rows and every historical registered section remain byte-identical. No historical result, prepared launch text, metadata, snapshot, seed, treatment, budget or launch gate changes. G2-5's launch-text-drift restriction and the separate smoke/main approval gates still apply; this maintenance entry authorizes no model call or batch launch.
<!-- /deviation:G2-8 -->

### CI maintenance: package names and earlier nested layouts

<!-- deviation:G2-9 -->
**G2-9** (2026-11-22, maintenance only; no benchmark calls). Follow-up verification of G2-8 found that Cargo 1.93's nested layout places generated files at `build/<pkg>/<hash>/build-script-execution/out/`, while Cargo 1.99 places them directly at `build/<pkg>/<hash>/out/`. Both put execution fingerprints at `build/<pkg>/<hash>/fingerprint/`. The offline regeneration test now accepts these two observed nested output paths explicitly, and its six focused layout and preservation cases pass under both installed toolchains.

The build-dir scan now examines only package/unit/fingerprint directories, leaving output and execution-metadata subtrees unvisited. This also handles valid package names `out`, `run` and `fingerprint`, which G2-8's recursive traversal would either skip or confuse with a fingerprint directory. Regression fixtures cover all three names, retained older `build-script-execution` metadata and generated files, source-pointing symlinks, compiled artifacts, and dependency identity.

G2-9 supersedes G2-8 to re-pin `lib.mjs` and `runner.test.mjs`, repeating its other six source/task pins and all three analysis pins unchanged. The preceding 34 registration rows, including G2-8, and all historical registered sections remain byte-identical. Historical evidence, launch texts, metadata, snapshots, seeds, treatments, budgets and gates are unchanged. G2-5's launch-text-drift restriction and separate smoke/main approval gates remain; no benchmark call or batch launch is authorized.
<!-- /deviation:G2-9 -->
