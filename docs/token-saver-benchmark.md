# Token saver benchmark

How many tokens do PandaCode's token saver packs save when a lead agent picks them for the workers it dispatches, and does the work stay as good? This page holds the method, the pre-registration and, later, the results. The runner is `scripts/agent-bench/saver.mjs`; it shares the ledger, recorded PIDs, disk floor and checkout isolation of the [agent loop benchmark](agent-loop-benchmark.md), whose house standards it follows.

## Results in short (batch S1v3)

S1v3 ran in full on 2026-11-07: 340 worker runs and 170 selector calls, Sonnet workers in Claude Code 2.1.317, explore snapshot `bin-f` (deviation S1v3-1). Details are under [Batch S1v3 results](#batch-s1v3-results).

- **Output tokens: not shown to be lower.** 1,711 → 1,671 per run, -1% (CI -5% to +4%), Holm p = 0.71.
- **Billed cost, with the selector's inline field: not shown to be lower.** $0.157 → $0.159, +1% (CI -0.5% to +2.7%), Holm p = 0.71.
- **Input and cache tokens rose** 6% (CI +1% to +11%, Wilcoxon p = 0.041), a secondary measure.
- **Gates.** Localization recall **failed: not shown non-inferior** (0.781 → 0.766, CI -0.054 to +0.019, margin -0.05). Localization precision passed (CI -0.043 to +0.002). Task success passed (0.881 → 0.890, CI 0.000 to +0.025, margin -0.15).
- **What the lead picked.** Caveman lite plus quiet-tools on every one of the 170 picks; lean-code was added on every edit, rtk on 8 of 10 failing-test reports. It never picked none, and no reply was invalid.
- So, as the lead picks them today, the packs saved no measurable tokens or money on these worker tasks, and localization recall is not shown to be unharmed.
- **POST-HOC sensitivity (round 17, written after the results).** The registered rubrics scored the topic, not correctness: answers stating the opposite facts scored full marks. Rescored blind to arm with strict rubrics that refuse such answers, task success is unchanged (0.881 → 0.890, CI 0.000 to +0.025): the strict patterns found no case of an answer earning an item with a wrong statement. This is circular in part: two strict patterns were loosened after they rejected correct units in these same answers (deviation S1v3-2). Resampling NONE against itself, the gates pass 78% (recall), 93% (precision) and 95% (task success) of no-effect batches, so a recall failure is what no effect produces about one time in five. See [Post-hoc sensitivity](#post-hoc-sensitivity-round-17).

Registrations are local: `scripts/agent-bench/results/preregistrations.jsonl` is hash-chained and timestamped by this machine's clock only, with no anchor in git or any outside service. The chain shows that no entry was edited after the next one was written, not when an entry was written.

## Method in short

Batch S1 below was registered but never run. Council round 12 found it unrealistic and underpowered, so it is superseded by **S1v2**, registered under it. The S1 section stays as written because its sha256 is in the chain.

From S1v2 on, every run is one worker-style Claude Code run (`claude -p`, the pinned harness, permissions skipped inside a fresh `git archive` checkout). The worker has `pandacode_explore` through the explore MCP server snapshot that `run.mjs` uses for AFTER, and the `LOOK` clause appended to its system prompt, as workers run in the app. Its message is the report sentence of the worker brief, then the task prompt, then the token saver block. The two arms differ only in the block:

- `NONE`: no block.
- `CHOSEN`: first, a selector call shows the lead model the shipped lead guidance and the task prompt and asks for the `tokenSaver` value; the worker then gets that block.

The block is built by the shipped `guidance()` from a snapshot of `src/token-saver.ts` taken at `--prepare` (sha256 in `meta.json`, `batch.json` and every run, beside the sha256 of `src-tauri/src/token_saver.rs`), so it is the app's own text, not a copy. In the app a worker's block comes from `token_saver::guidance` in Rust, whose own test holds it equal to the window's `guidance()` for all 96 pack, level and rtk combinations; `saver.test.mjs` checks that the benchmark's block equals what `contextFor()` appends to a fresh thread's first message for every pick tried, rtk installed or not.

<!-- prereg:S1 -->
### Pre-registration: batch S1

Fixed on 2026-11-06, before any run of the batch. Only two smoke tests (two tasks, three arms, seed 99, batch `smoke`; the first with a stand-in guidance, the second with the shipped one) ran before this was written; their runs are never analysed with S1.

**Question.** Against no saver, how much do the packs a lead chooses for a worker save in output tokens, and do localization, edits and reports stay non-inferior?

**Arms.** `NONE`, `CHOSEN` and `ALL`, as above. Every arm runs Claude Code 2.1.317 with the worker model `sonnet` (pinned to `claude-sonnet-5-5` in `tasks.json`; a run that resolves to another model aborts the batch) and the same flags (`harnessArgs` arm `before`: `--strict-mcp-config`, empty MCP config, `--setting-sources project`, `--no-session-persistence`). The block is appended to the task prompt after a blank line, as `saver_block` in `architect.rs` appends `Applied::block()` to a worker's assignment. A pick with no packs, or only `rtk` without rtk installed, sends no block, as the app does. The worker's team briefing is not reproduced: every arm gets the bare task prompt.

**Selector (CHOSEN).** One call per task and seed, cached in `<out>/selections/` and reused if the batch resumes. Model `opus` (the lead's model, `claude-opus-5-5`), no tools (`--tools ""`), a replaced system prompt holding only the lead's role, the shipped lead guidance and the reply format, and the worker's prompt as the user message. The lead guidance is the `tokenSaver` sentence of the dispatch tool's description plus the parameter's own description (`token_saver_schema`), read from `src-tauri/src/architect.rs` at `--prepare` and hashed into `meta.json`, `batch.json` and every run; `saver.mjs` refuses a batch while only the stand-in built from `PACKS` is available. The selector is told that its own thread has no token saver, so leaving `tokenSaver` out means none. Its reply is validated as `token_saver::parse` validates an assignment: `"none"`, or `{packs, level}` with known packs and a level only beside `caveman` (default `full`); null or an omitted value means none. Anything else is an invalid pick, gives no block, and is reported. The selector's billed cost is added to its CHOSEN run's cost.

**Tasks** (`scripts/agent-bench/tasks-saver.json`, 34):

- 20 localization tasks from `tasks.json` (13 PandaCode, 6 Outline, 1 VS Code), graded as in the agent loop benchmark: recall and precision of the answer's file list against the source commit's gold.
- 6 edit tasks from `tasks.json`, graded by their commit's tests plus the suite with no new failures (only tasks whose sanity verdict is `ok`).
- 8 report tasks, typical worker reports with deterministic rubrics written before any run. A rubric item scores when one line of the final answer matches all of its case-insensitive regexes; report recall is the share of items hit. No LLM judge.
  - 3 reviews (`rep-review-deepseek`, `rep-review-simulator`, `rep-review-pi-launcher`): a real fix commit's change applied uncommitted over its parent, with 2–3 planted defects; the rubric is the planted defects (7 items).
  - 3 explanations at `df884aa` (`rep-explain-secrets`, `rep-explain-queue`, `rep-explain-saver-resend`): facts the code states (27 items).
  - 2 failing-test summaries (`rep-fail-sidebar`, `rep-fail-appimage`): an edit task's commit tests over its parent; the rubric is each failing test's name and the cause (12 items).

**Seeds.** Seeds 1 and 2 for `NONE` and `CHOSEN`; seed 1 only for `ALL`. 170 worker runs and 68 selector calls. A seed is a replicate: the runs are not deterministic. Job order and the arm order inside each (task, seed) group come from the batch seed recorded in `batch.json`.

**Primary metric.** Output tokens per run (the sum of the result segments' `output_tokens`), `NONE` → `CHOSEN`: per-task means over seeds, two-sided Wilcoxon signed-rank on the per-task differences, and a 95% bootstrap CI of the mean per-task relative change. It is read as lower only if p < 0.05 and the CI excludes 0.

**Secondary metrics**, one Westfall-Young max-T family over the per-task relative changes: billed cost including the selector, input plus cache read plus cache write tokens, steps (distinct model requests of the main agent) and wall time. Read as lower or higher only if the max-T p < 0.05 and the CI excludes 0.

**Gates**, non-inferiority with margin −0.05: localization recall, localization precision, edit pass rate and report rubric recall, each passing only if the lower end of the 95% bootstrap CI of the mean per-task difference is above −0.05. A failed gate means the saving is not claimed as free, whatever the token numbers.

**Also reported.** `NONE` → `ALL` and `CHOSEN` → `ALL` with the same tables and gates (descriptive: `ALL` has one seed, so its per-task mean is one run while the other arm's is two); output tokens by task set; the pack mix the selector chose per task type (`loc`, `edit`, `report:review`, `report:explain`, `report:failing`), including levels, empty picks and invalid replies; selector cost; failures.

**Exclusions.** None after the fact. A run that errors or times out keeps its measured tokens and fails its quality measure; a run lost to a crash is charged its cap and rerun by the runner.

**Cost.** Estimated $31 (loc and edit at batch D's billed means, $0.17 and $0.16; reports at the smoke test's $0.20; selector $0.015 a call); each smoke test cost about $0.90 for 6 runs and 2 selector calls ($0.009–0.012 a selector call). No spending cap: the user approved unlimited spend. The runner's `--total-budget-usd` (1000) is only a guard against a runaway loop, and `--run-cap-usd 5` is set so no run is cut short by its cap.

**Commands.**

```sh
S="node scripts/agent-bench/saver.mjs"
$S --prepare          # snapshot src/token-saver.ts and the lead guidance; record harness and rtk
$S --check-tasks      # anchors, rubric patterns, sanity verdicts; no model time
$S --plan             # 170 runs, about $31
$S --batch S1 --concurrency 4
node scripts/agent-bench/analyze.mjs --saver --runs ~/Library/Caches/pandacode-bench/saver/runs/S1 --summary scripts/agent-bench/results/saver-S1.json
```

`--from` defaults to `~/Library/Caches/pandacode-bench/v2`, which supplies the pinned harness, the Outline and VS Code clones and `sanity.json`; run `run.mjs --prepare` and `run.mjs --sanity` there first if it is missing.
<!-- /prereg:S1 -->

<!-- prereg:S1v2 -->
### Pre-registration: batch S1v2

Written on 2026-11-07, before any S1v2 run. It replaces S1, which never ran: no S1 run exists, so nothing is dropped or re-analysed. This section stays as written. Its sha256, its time and the sha256 of `tasks-saver.json` and `tasks.json` are in `scripts/agent-bench/results/preregistrations.jsonl` (entry `S1v2`, `supersedes: S1`), and `check.test.mjs` fails if any of them changes.

**What changed from S1, and why (council round 12, scored 6.0):**

1. **Guidance drift.** S1 looked for a `tokenSaver (` sentence that the shipped dispatch tool no longer has, so it would have run on a stand-in built from `PACKS`.
   - `findLeadGuidance` now reads the dispatch description from `tokenSaver:` onward in the real `src-tauri/src/architect.rs`, plus `token_saver_schema` when that function exists. A test runs it on the real file and fails if it finds nothing.
   - The stand-in and `--allow-fallback-guidance` are gone.
   - `loadMeta` re-extracts the guidance, the worker report sentence and `LOOK`, and refuses to start if any sha256 differs from the snapshot taken at `--prepare`.
   - Selector picks are cached by guidance sha256, so a pick made under old guidance is never reused.
   - The selector's reply format shows only the shape `{"tokenSaver": <value>}`. S1's examples named `quiet-tools`, which could have primed it.
2. **Realism.** Workers in the app get their brief and have `pandacode_explore`. S1 gave neither. S1v2 gives both to every arm:
   - the report sentence of the worker rules in `architect.rs` (with the default 3072-byte summary limit), placed before the task prompt;
   - the explore server snapshot recorded in `meta.json` (`--snapshot`, default `bin-f`, which pins the binary hash);
   - the `LOOK` sentence from `lib.rs` as `--append-system-prompt`.
3. **Metrics.**
   - Two co-primaries, Holm-adjusted: output tokens, and billed cost.
   - The secondary is input plus cache tokens. Steps and wall time are descriptive.
   - In the app the lead picks inline, so the selector's marginal cost is the `tokenSaver` field it writes. That cost (the selector's output tokens at the lead model's output price) is added to CHOSEN's cost. The cost of the separate selector call is reported on its own line and never folded in.
4. **Gates.** A no-effect simulation (`saver.mjs --simulate`) showed that a −0.05 margin fails most batches that have no true difference. Even edits and reports pooled, with 3 seeds, pass only 17% of no-effect batches at −0.05.
   - The localization recall and precision gates (margin -0.05) stay as confirmatory gates.
   - Edit pass and report recall are pooled into one paired task-success gate, with the margin chosen by that simulation (below).
5. **Rubrics.**
   - Every pattern is anchored at word boundaries.
   - Generic items were dropped: `steering`, `defaults`, the bare `header`, and S1's `why-no-keychain` alternatives (`prompt`, `sign`, `password`).
   - Bare numbers now need context, as in `every 8` and `128 KiB`.
   - Reviews are scored per finding: the items of the answer's JSON `findings` array and each top-level numbered or bulleted finding are scored apart, so one finding can't borrow words from another.
   - A negative-control test scores each task's rubric on every other task's smoke answer and on a vague fake answer. Each must score at most 1 item.
6. **Arms and seeds.** `ALL` is dropped: with one seed it was only descriptive. Its runs went to a third seed, so `NONE` and `CHOSEN` each run seeds 1, 2 and 3.
7. **Analysis guards.** The analyzer refuses a batch whose `batch.json` or registration pins a different `tasks-saver.json`. It also excludes, with a note, any run whose `init.model` is not the pinned model.

**Question.** Against no saver, do the packs a lead picks for a worker save output tokens and billed cost, with localization and task success non-inferior?

**Arms.** `NONE` and `CHOSEN`, as in "Method in short". Every run uses Claude Code 2.1.317 and the worker model `sonnet`, which `tasks.json` pins to `claude-sonnet-5-5`. A run that resolves to another model aborts the batch and is excluded from the analysis. The flags are `harnessArgs` arm `after`: `--strict-mcp-config` with the explore server's config only, `--append-system-prompt` with `LOOK`, `--setting-sources project` and `--no-session-persistence`. The message is `<report sentence>\n\n<task prompt><block>`. A pick with no packs, or only `rtk` without rtk installed, sends no block, as the app does.

**Selector (CHOSEN).**
- One call per task and seed, cached in `<out>/selections/` under the guidance sha256.
- Model `opus` (`claude-opus-5-5`), with no tools and a replaced system prompt. The prompt holds only the lead's role, the shipped lead guidance, the note that the lead's own thread has no saver, and the reply shape. The worker's prompt is the user message.
- Replies are validated as `token_saver::parse` validates an assignment. An invalid reply gives no block and is reported.

**Tasks** (`scripts/agent-bench/tasks-saver.json`, 34):
- 20 localization tasks and 6 edit tasks from `tasks.json`, graded as before.
- 8 report tasks (3 reviews, 3 explanations, 2 failing-test summaries) with the rewritten rubrics: 44 items in all (reviews 7, explanations 25, failing tests 12).

**Seeds and size.**
- Seeds 1, 2 and 3 for both arms: 204 worker runs (120 localization, 36 edit, 48 report) and 102 selector calls.
- Job order, and the arm order inside each (task, seed) group, come from the batch seed recorded in `batch.json`.

**Co-primary metrics.** These are output tokens per run, and billed cost per run with CHOSEN's field cost added, both `NONE` → `CHOSEN`.
- Each uses per-task means over seeds and a two-sided Wilcoxon signed-rank test on the per-task differences, Holm-adjusted across the two.
- Each also gets a 95% bootstrap CI of the mean per-task relative change.
- A metric is read as lower only if its Holm p < 0.05 and its CI excludes 0. Otherwise it is "not shown to be lower".

**Secondary.** Input plus cache read plus cache write tokens, with Wilcoxon and the same CI. Steps and wall time are descriptive.

**Gates** (all on the mean per-task difference `CHOSEN − NONE`, 95% bootstrap CI over tasks):
- **Localization recall** and **localization precision** (20 tasks), confirmatory, margin −0.05: each passes only if the CI's lower end is above −0.05.
- **Task success** (14 tasks): an edit run scores 1 if it passes and 0 if not; a report run scores its rubric recall. The gate passes only if the CI's lower end is above **−0.20**.
  - The margin comes from `saver.mjs --simulate`: 2000 simulated batches per setting, the gate's own bootstrap, 3 seeds. Edit pass rates are BEFORE's per-task rates in batches E and E2, shrunk as (passes + 0.5) / (runs + 1). Each report item's hit rate is assumed, spread evenly over 0.35–0.95 within its rubric, because no NONE report data exists yet.
  - Probability that the gate passes, by margin and by true effect:

    | True effect | −0.05 | −0.10 | −0.15 | −0.175 | **−0.20** | −0.25 |
    |---|---:|---:|---:|---:|---:|---:|
    | none | 0.17 | 0.41 | 0.68 | 0.77 | **0.85** | 0.95 |
    | −0.05 | 0.05 | 0.17 | 0.40 | 0.52 | 0.64 | 0.83 |
    | −0.10 | 0.01 | 0.05 | 0.16 | 0.26 | 0.38 | 0.61 |
    | −0.20 | 0 | 0 | 0.01 | 0.02 | 0.04 | 0.14 |

  - −0.20 is the narrowest margin on the grid that passes a no-effect batch at least 80% of the time. With 14 tasks and 3 seeds this gate only rules out large losses: a true loss of 0.10 still passes 38% of the time. With 5 seeds −0.15 would reach 0.86; that is not what S1v2 runs.
- A failed gate means the saving is not claimed as free, whatever the token numbers.

**Also reported.**
- Output tokens by set (descriptive).
- The pack mix the selector chose per task type, with levels, empty picks and invalid replies.
- The standalone selector cost and the inline field cost.
- Failures.
- Runs excluded for the wrong model.

**Exclusions.** Only runs whose `init.model` is not the pinned model. A run that errors or times out keeps its measured tokens and fails its quality measure. A run lost to a crash is charged its cap and rerun.

**Cost.** Estimated $37.65:
- localization at $0.17 a run, edits at $0.17 (batch E's AFTER means);
- reports at $0.20 (the S1 smoke tests);
- the selector at $0.015 a call.

`--run-cap-usd 5` is set so no run is cut short. `--total-budget-usd 1000` only guards against a runaway loop.

**Commands.**

```sh
S="node scripts/agent-bench/saver.mjs"
node scripts/agent-bench/run.mjs --prepare --snapshot bin-f   # the explore server snapshot every arm uses
$S --prepare          # snapshot token-saver.ts; read the lead guidance, the worker report sentence and LOOK; pin the explore binary
$S --check-tasks      # anchors, rubric patterns, sanity verdicts; no model time
$S --simulate         # the task-success margin table above
$S --plan             # 204 runs and 102 selector calls, about $38
$S --smoke --tasks rep-review-simulator,rep-explain-secrets   # 2 tasks × 2 arms, seed 99, about $0.83
$S --batch S1v2 --concurrency 4 --run-cap-usd 5
node scripts/agent-bench/analyze.mjs --saver --runs ~/Library/Caches/pandacode-bench/saver/runs/S1v2 --summary scripts/agent-bench/results/saver-S1v2.json
```

`--from` defaults to `~/Library/Caches/pandacode-bench/v2`. That folder supplies the pinned harness, the Outline and VS Code clones, `sanity.json` and the explore snapshot.
<!-- /prereg:S1v2 -->

### S1v2 deviations

<!-- deviation:S1v2-1 -->
**S1v2-1** (2026-11-07, after the S1v2 smoke and before any S1v2 batch run). Registered with the new `tasks-saver.json` sha256; it supersedes S1v2's file pins.

1. **Two `rep-explain-secrets` rubric items were widened.** The smoke's NONE answer gave both facts in words the items didn't accept, so they would have been scored as misses:
   - `keychain-migrates`: it said `file_set()` "saves the value to the file, and only then does `Keychain.delete()` run". The item now also accepts `save … to/in the file`.
   - `why-no-keychain`: it said Keychain items "were pinned to the build that made them, so every update asked for the login password". The item now also accepts `pinned to the build` and `every update`.
   - Both still need `keychain` in the same line. Every other-task answer still scores at most 1 item on every rubric. The only exception is the documented `sameTopic` answer, which scores 3 on `rep-explain-secrets` as before.
   - Kept unchanged: `home-button-inverted` missed in both simulator smoke answers. They flag the `pearl-id` line but say a missing key gives a home button. That is wrong for the planted `== Some(true)`, so it is a true miss.
2. **The 4 S1v2 smoke answers are new negative controls** (`smoke-S1v2:*`). With S1's queue answers, every report task is now scored on at least 2 real answers to other report tasks. `saver.test.mjs` asserts this.
3. **The pack text is pinned.** `src/token-saver.ts` now imports its pack text from `src/token-saver-packs.json`. `--prepare` copies that file beside the snapshot, and `meta.json`, `batch.json` and every run record its sha256 (`packsSha256`). `loadMeta` refuses a changed copy.
4. **Smoke runs go to `runs/smoke-<batch>`**, here `runs/smoke-S1v2`. This keeps them apart from S1's `runs/smoke`.

The lead guidance text changed after S1v2 was written (final round 15 wording). This is not a deviation: the design reads it live at `--prepare` and pins its sha256 (`56444a79…`).
<!-- /deviation:S1v2-1 -->

<!-- prereg:S1v3 -->
### Pre-registration: batch S1v3

Written on 2026-11-07, before any S1v3 run. It supersedes S1v2 and its deviation S1v2-1. S1v2 never ran a batch (only its smoke test, which is never analysed), so nothing is dropped or re-analysed. This section stays as written. Its sha256, its time and the sha256 of `tasks-saver.json` and `tasks.json` are in `scripts/agent-bench/results/preregistrations.jsonl` (entry `S1v3`, `supersedes: S1v2`), and `check.test.mjs` fails if any of them changes.

**Everything in S1v2 and S1v2-1 holds** (question, arms, selector, tasks and rubrics, co-primaries with Holm, secondary, localization gates, exclusions, analysis guards), except for what this section changes.

**What changed from S1v2, and why (council round 13):**

1. **Seeds and margin.** With 3 seeds the task-success gate needed a −0.20 margin, and a true loss of 0.10 still passed 38% of the time. S1v3 runs **5 seeds** (1–5) for `NONE` and `CHOSEN`, and the task-success margin is **−0.15** (`TASK_SUCCESS_MARGIN` in `analyze.mjs`).
   - `saver.mjs --simulate` (defaults to 5 seeds; `--sim-seeds 3` gives S1v2's table): 2000 simulated batches per cell, the gate's own bootstrap, the same edit rates and assumed report item rates as S1v2. P(the gate passes):

     | True effect | −0.05 | −0.10 | −0.125 | **−0.15** | −0.175 | −0.20 | −0.25 |
     |---|---:|---:|---:|---:|---:|---:|---:|
     | none | 0.23 | 0.57 | 0.74 | **0.86** | 0.93 | 0.97 | 1.00 |
     | −0.05 | 0.04 | 0.21 | 0.38 | 0.55 | 0.72 | 0.84 | 0.96 |
     | −0.10 | 0.00 | 0.04 | 0.11 | 0.21 | 0.36 | 0.53 | 0.83 |
     | −0.20 | 0 | 0 | 0.00 | 0.00 | 0.02 | 0.04 | 0.20 |

   - −0.15 is the tightest margin on the grid with P(pass | no effect) ≥ 0.85; −0.125 gives 0.74. A true loss of 0.10 now passes 21% of the time, against 38% in S1v2. `saver.test.mjs` asserts both bounds at 2000 reps.
2. **Shipped texts after round 16.** `--prepare` reads them live and pins their sha256, as in S1v2:
   - the lead guidance: the dispatch description's final `tokenSaver:` text plus `token_saver_schema` (in `src-tauri/src/architect/saver.rs`);
   - the pack text in `src/token-saver-packs.json`;
   - `LOOK` as `look()` builds it for Claude Code: `LOOK` with `{explore}` replaced, then `EDIT_CLAUDE`;
   - the explore snapshot `bin-f`, rebuilt for Fv2.

   The hashes are in "Snapshot" below.
3. **Runner.** `saver.mjs` shares `run.mjs`'s runner core (`lib.mjs`). Two behaviours change:
   - after a crash, an open run is charged the larger of its cap and the cost its transcript last reported (S1v2's copy charged the cap only);
   - the pool no longer stops while runs are in flight. A job starts only if its cap plus $1 for a `CHOSEN` run's selector call fits the budget.

**Seeds and size.** 34 tasks × 2 arms × seeds 1–5: 340 worker runs (200 localization, 60 edit, 80 report) and 170 selector calls.

**Cost.** Estimated **$62.75** by `saver.mjs --plan`, at S1v2's per-run means. `--run-cap-usd 5`, `--total-budget-usd 1000`.

**Snapshot** (`saver.mjs --prepare`, before registration): lead guidance sha256 `796ef500c36177d107777f9fbb7bcb44388f9d5b9f383443fbc8310fa57470d7`, worker report `dd87a377710ca984afaf4640225b39a6d1f6402c09090e6c2454f4b541dc43f9`, `LOOK` `c134797c27f930c5f57684a4ae8f908bcc8e7b7d190a320236666e1449d782f2`, `token-saver.ts` `15c11865bc5ecfb66813ad6ddbcb1c9b6422dad7aeb60fdbb6e742da6f723acb`, `token-saver-packs.json` `c3e2ee6eb05ce7e72eeb3b2db091a5ee23a69525c885aac3c115d23cdccfa321`, explore binary `ecbbd0c1…`, rtk 1.0.1.

**Commands.**

```sh
S="node scripts/agent-bench/saver.mjs"
node scripts/agent-bench/run.mjs --prepare --snapshot bin-f
$S --prepare
$S --check-tasks
$S --simulate                     # the table above
$S --plan                         # 340 runs and 170 selector calls, about $63
$S --batch S1v3 --smoke --tasks rep-explain-secrets   # 1 task × 2 arms, seed 99, runs/smoke-S1v3
$S --batch S1v3 --concurrency 4 --run-cap-usd 5
node scripts/agent-bench/analyze.mjs --saver --runs ~/Library/Caches/pandacode-bench/saver/runs/S1v3 --summary scripts/agent-bench/results/saver-S1v3.json
```
<!-- /prereg:S1v3 -->

### S1v3 deviations

<!-- deviation:S1v3-1 -->
**S1v3-1** (2026-11-07, after registration and before any S1v3 run). The explore snapshot every arm uses, `bin-f`, was rebuilt (agent loop benchmark deviation Fv2-1), so `saver.mjs --prepare` was rerun:

- explore binary sha256 `ecbbd0c1…` → `34c3de0750ce1ecd43d534887cddb8c5f5a2abe695e85187447cf193037e1090`;
- explore sources sha256 `6bf059d8…` → `e92e0a7ed1c1b00aa6ab822f6755717e602d5025354481d03cb38c9bd44e9b04`.

Why: `src-tauri/src/lib.rs` changed after registration (the `REUSE` sentence and one comment; `REUSE` is not sent in any S1v3 arm), and the test-only R1 bench hook was added to `custom_tools.rs` and `providers/mcp_host.rs`. No explore engine file changed. Every other snapshot hash is unchanged: lead guidance `796ef500…`, worker report `dd87a377…`, `LOOK` `c134797c…`, `token-saver.ts` `15c11865…`, packs `c3e2ee6e…`, `tasks-saver.json` `d7f59d06…`, rtk 1.0.1.
<!-- /deviation:S1v3-1 -->

<!-- deviation:S1v3-2 -->
**S1v3-2** (2026-11-07, round 17). **POST-HOC: written after S1v3's results were known and published.** No registered verdict changes; the registered rubrics in `tasks-saver.json` are unchanged (its sha256 is pinned by the registration).

1. **Rubrics score the topic (council round 14).** Answers stating the opposite facts scored 100% on `rep-explain-queue`, `rep-explain-saver-resend`, `rep-review-pi-launcher` and `rep-review-simulator`. `scripts/agent-bench/results/s1v3-strict-rubrics.json` holds, for every report task, strict rubrics (each item keeps its registered patterns, adds the correct value or the defect statement where the item named only the topic, and lists `not` patterns that refuse negations and wrong values; failing-test names count only inside the answer's JSON `failing` array) and two same-topic wrong answers, one negated and one with wrong values. The registered rubrics give the negated answers 2 to 10 items; the strict ones give every wrong answer 0 (`saver.test.mjs` requires at most 1, and that right answers keep their score). Two strict patterns were loosened after they were seen to reject correct units in recorded answers (`rtk-needs-install` now accepts "minus rtk if it isn't installed"; a `cause-commented` exclusion that hit "does not match the commented-out line" was dropped). The units were shown without arm labels.
2. **Blind rescoring.** `analyze.mjs --saver --strict-rubrics …` rescores the recorded report answers from a shuffled sheet of (opaque key, task, answer), with no arm, seed or run id, then joins the scores back. The answers' own wording can still hint at the arm (caveman style).
3. **No-effect check (descriptive).** `--no-effect` resamples NONE's runs against themselves (per task, two samples of its 5 runs with replacement), 1000 batches, the gates' own rule.
4. **Analysis code hashes, taken after the analysis.** S1v3 registered none. The code that produced `results/saver-S1v3-posthoc.json` (and reproduces `saver-S1v3.json` exactly) is `analyze.mjs` `9e08daecbc349bf7d8ccdd57915455ce3bad7974d896823705ac29d4c349acad`, `metrics.mjs` `f24bafbebca21aeb10c96cfa526db163bc03142fcd537358380b836b98110cc6`, `stats.mjs` `a3b9fe4de3311271a7716b241c0ee2453e34629839a972c590202705a67a6462`. `analyze.mjs` now prints `MISMATCH` when the analysis code differs from a batch's newest registered hashes, and every registration records them from now on.
5. **A claim in S1v2's registration is wrong.** It says "Every pattern is anchored at word boundaries". Two are not: `at-prefix-not-stripped` matches a bare `@`, and `lock-file`'s `\.lock\b` is anchored only at its end; failing-test names are literal phrases. The S1v2 text and `tasks-saver.json`'s `about` are pinned, so the correction is here.
6. **Project settings.** No S1v3 checkout held `.claude/`, `.mcp.json` or `CLAUDE.md` after pruning (PandaCode never had them; Outline's `.claude/skills` and VS Code's `.mcp.json` were pruned), and no run's `init` lists a project skill or hook; `AGENTS.md` was present as in the agent loop benchmark (its deviation Fv2-2). Later batches delete those files anywhere in the tree and pin their Rust build inputs.
<!-- /deviation:S1v3-2 -->

## Batch S1v3 results

Run on 2026-11-07 as registered, with deviation S1v3-1 (the rebuilt explore snapshot). Sonnet (`claude-sonnet-5-5`) workers in Claude Code 2.1.317; selector `opus`. Every run's snapshot hashes match "Snapshot" above except the explore binary and sources (`34c3de07…`, `e92e0a7e…`).

**What ran.** The smoke (`rep-explain-secrets`, both arms, seed 99, rerun on the rebuilt snapshot) scored 10 of 10 rubric items in both arms. Then all 340 worker runs and 170 selector calls, at concurrency 4, with no stop, no crash, no rerun and no run excluded for its model. 10 runs failed their quality measure, all edits failing their tests (5 per arm; they count as failures, as registered). Billed: $53.50 for worker runs plus $0.89 for the separate selector calls, **$54.39** (the smoke $0.36).

Per-run data: `scripts/agent-bench/results/runs/saver-S1v3.csv` (with each CHOSEN run's pick in `packs`); summary: `scripts/agent-bench/results/saver-S1v3.json`.

**Co-primaries and secondary** (34 tasks, per-task means over 5 seeds; mean of per-task relative changes):

| Metric | Role | NONE | CHOSEN | Mean change | 95% CI | Wilcoxon p | Holm p | Better / worse | Read |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| Output tokens | co-primary | 1,711 | 1,671 | -1.0% | -5.3% to +3.6% | 0.448 | 0.707 | 19 / 15 | not shown to be lower |
| Billed cost $, with the inline field | co-primary | 0.1572 | 0.1587 | +1.1% | -0.5% to +2.7% | 0.353 | 0.707 | 15 / 19 | not shown to be lower |
| Input + cache read + cache write tokens | secondary | 171,034 | 180,131 | +5.8% | +0.8% to +11.0% | 0.041 | – | 9 / 25 | higher |
| Steps | descriptive | 4.10 | 4.26 | +5.1% | +0.4% to +10.0% | 0.091 | – | 9 / 18 | descriptive |
| Wall s | descriptive | 23.67 | 24.30 | +1.1% | -2.7% to +5.0% | 0.748 | – | 15 / 19 | descriptive |

- The cost column includes the inline field ($0.21 over 170 picks, about $0.0012 a pick, priced at the lead's output price). The separate selector calls cost $0.89 ($0.0052 a call) and are not folded in, as registered.
- Means over runs: cache reads 139,482 → 148,659, cache writes 31,544 → 31,463, uncached input 8 → 9. The rise is in cache reads: the block adds about 1 KB to the message and CHOSEN took slightly more steps, each re-reading the prompt.

**Output tokens by set** (descriptive):

| Set | Tasks | NONE | CHOSEN | Mean change | 95% CI | Wilcoxon p |
|---|---:|---:|---:|---:|---:|---:|
| Localization | 20 | 1,589 | 1,594 | +0.6% | -4.9% to +6.7% | 0.986 |
| Edits | 6 | 2,550 | 2,260 | -11.5% | -19.0% to -4.1% | 0.063 |
| Reports | 8 | 1,386 | 1,419 | +3.0% | -5.0% to +10.7% | 0.641 |

Edits are the only set whose CI excludes zero, with 6 tasks; 5 were better and 1 worse, and the smallest p 6 tasks allow is 0.031, so it is not shown to be lower.

**Gates** (mean per-task difference CHOSEN − NONE, 95% bootstrap CI):

| Gate | NONE | CHOSEN | Difference | 95% CI | Margin | Result |
|---|---:|---:|---:|---:|---:|---|
| Localization recall (20 tasks) | 0.781 | 0.766 | -0.015 | -0.054 to +0.019 | -0.05 | **fail: not shown non-inferior** |
| Localization precision (20 tasks) | 0.552 | 0.533 | -0.019 | -0.043 to +0.002 | -0.05 | pass |
| Task success (14 tasks: 6 edits, 8 reports) | 0.881 | 0.890 | +0.009 | 0.000 to +0.025 | -0.15 | pass |

- Edits passed 25 of 30 in both arms. Report rubric recall, means over runs, was 0.916 → 0.932.
- The recall gate misses its margin by 0.004.

**Pack mix chosen by the selector** (170 picks, 0 invalid, 0 none):

| Task type | Picks | caveman | level | quiet-tools | lean-code | rtk |
|---|---:|---:|---|---:|---:|---:|
| Localization | 100 | 100 | lite ×100 | 100 | 0 | 0 |
| Edits | 30 | 30 | lite ×30 | 30 | 30 | 0 |
| Reviews | 15 | 15 | lite ×15 | 15 | 0 | 0 |
| Explanations | 15 | 15 | lite ×15 | 15 | 0 | 0 |
| Failing-test summaries | 10 | 10 | lite ×10 | 10 | 0 | 8 |

The selector followed the shipped guidance literally ("Research/review/read-only: quiet-tools+caveman lite", "Code: lean-code+quiet-tools+caveman lite", "Test/build/install heavy: add rtk"), so CHOSEN measures that mix, mostly caveman lite plus quiet-tools.

**Reading.** Neither co-primary is shown to be lower, so no token or cost saving is claimed. Input and cache tokens rose. Localization recall is not shown non-inferior. The edit output saving (-11%, 6 tasks) is a lead for a batch built for it, not a result.

### Post-hoc sensitivity (round 17)

**POST-HOC: written after S1v3's results were known (deviation S1v3-2). Sensitivity only; the registered result above stands.** Summary: `scripts/agent-bench/results/saver-S1v3-posthoc.json`.

| Task success (14 tasks, margin −0.15) | NONE | CHOSEN | Difference | 95% CI | Verdict |
|---|---:|---:|---:|---:|---|
| Registered rubrics (registered) | 0.881 | 0.890 | +0.009 | 0.000 to +0.025 | pass |
| Strict rubrics, blind rescoring (sensitivity) | 0.881 | 0.890 | +0.009 | 0.000 to +0.025 | would pass |

Every report run scored the same under both rubrics, task by task (means over runs, NONE → CHOSEN): queue 0.850 → 0.875, saver resend 0.914 → 0.914, secrets 1 → 1, simulator 0.667 → 0.667, pi launcher 0.900 → 1, deepseek, sidebar and appimage 1 → 1. The registered rubrics could have been fooled; the strict patterns found no case in S1v3. (Round 18 wording; it used to say they "were not" fooled.) The check is not independent of these answers: two strict patterns were loosened after they were seen to reject correct units in them (deviation S1v3-2), so a wrong answer phrased like those units could still pass.

**No-effect pass rates** (NONE resampled against NONE, 1000 batches; descriptive):

| Gate | Margin | P(pass), no effect |
|---|---:|---:|
| Localization recall | −0.05 | 0.78 |
| Localization precision | −0.05 | 0.93 |
| Task success | −0.15 | 0.95 |

Recall fails about one no-effect batch in five, so its failure (it missed the margin by 0.004) is "not shown non-inferior", not evidence of a loss. Task success passes 95% with no effect, close to the 0.86 the registration simulated from assumed item rates.

```sh
node scripts/agent-bench/analyze.mjs --saver --runs ~/Library/Caches/pandacode-bench/saver/runs/S1v3 --strict-rubrics scripts/agent-bench/results/s1v3-strict-rubrics.json --no-effect --summary scripts/agent-bench/results/saver-S1v3-posthoc.json
```

## Notes on the design

- Output tokens are a co-primary because the packs mostly change what the agent writes; billed cost is the other, because it is what the user pays. Input and cache tokens are secondary: `quiet-tools` and `rtk` aim at tool output, which is billed as input on the next step, and the block itself adds a few hundred input tokens.
- Rubric patterns are mostly anchored at word boundaries; `@` (`at-prefix-not-stripped`), `\.lock\b` (`lock-file`, anchored at its end only) and the failing-test names are not (S1v3-2).
- Reports are scored by rubric lines (a review by its findings), not an LLM judge, so a terser answer neither gains nor loses for style. A fact split across two lines by a terse style can be missed; that is the quality risk the gate exists to catch, and it applies to every arm alike.
- Review tasks plant defects in a real change instead of reversing a fix, so the rubric names exactly what is wrong.
- The selector sees only the guidance and the prompt, as a lead does at dispatch; it does not see the repository.
- Negative controls: one smoke answer, `loc-connect-keychain` (a plan to move Connect's secrets out of the Keychain), is on the same subject as `rep-explain-secrets` and scores 3 of its items. It is marked `sameTopic` and is not used as a control for that task.
