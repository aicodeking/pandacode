# Agent loop benchmark: history

Earlier rounds of the [`pandacode_explore` benchmark](agent-loop-benchmark.md), moved out of it unchanged: round 2 results, round 3 (batch C, run as batch D) with batch D's results, and the corrected round 1 (v1) report. Round 2's pre-registration, which later batches build on, and every hash-pinned section stay in the main page.

## Round 2 results

Sonnet, 2026-11-05, explore snapshot `35f5bfb1` (sources `1dd86347`).

| Batch | Runs |
|---|---|
| A (3 arms) | 156 of 156 |
| L (long context) | 8 of 8 |
| B (2 arms) | 77 of 92 |
| Smoke | 4 |

The ledger shows $51.95: $47.95 billed by the harness, plus $4 charged as caps for the 4 killed runs. Sanitized numbers are in `scripts/agent-bench/results/v2-*.json`.

### Bottom line

- **Speed: yes, on localization.** AFTER took **17% fewer steps** (CI -23% to -11%, p < 0.001, 15 of 20 tasks better, 1 worse), and the drop held in both batches (A -15%, B -19%). Wall time fell 16% and duration 16%, both still significant after correction (max-T 0.013 and 0.007).
- **Cost: no.** Cost is +8% (within noise after correction). Each step re-sends larger results: later cache writes went from 2,095 to 3,873 tokens per step, step-weighted, and cache writes are +14% (significant). In the 150k-context arithmetic, cost is -3% (within noise).
- **Quality: not shown non-inferior.** The pre-registered gate fails.
  - Batch A passes recall but fails precision and edit pass.
  - Batch B fails recall (its lower bound is exactly -0.050, which doesn't clear the margin) and precision. Its edit runs never ran.
  - The point estimates aren't worse: recall 0.796 → 0.820 and precision 0.556 → 0.553 pooled. The CIs are just wider than the margin.
- **Edits.** AFTER failed 2 of 12 edit runs where BEFORE passed all 12, both on the same task (see Failure causes).
- **The tool does the work, not the instruction.** INSTRUCTION alone changed nothing measurable against BEFORE: steps -1%, recall 0.799 → 0.790. AFTER against INSTRUCTION cut steps by 12% (p = 0.001).

### Gates (AFTER against BEFORE; the lower bound must clear -0.05)

| Batch | Recall | CI of change | Precision | CI of change | Edit pass | CI of change | Result |
|---|---:|---:|---:|---:|---:|---:|---|
| A | 0.799 → 0.832 | -0.010 to +0.082 | 0.558 → 0.561 | -0.071 to +0.073 | 1.000 → 0.833 | -0.500 to 0.000 | **fail** (precision, edits) |
| B (partial, no edits) | 0.793 → 0.807 | -0.050 to +0.081 | 0.546 → 0.545 | -0.061 to +0.055 | not run | – | **fail** (recall, precision) |
| Pooled | 0.796 → 0.820 | -0.022 to +0.073 | 0.556 → 0.553 | -0.066 to +0.058 | 1.000 → 0.833 | -0.500 to 0.000 | fail |

For INSTRUCTION against BEFORE (batch A), recall and precision pass and edit pass fails (1.000 → 0.833). For AFTER against INSTRUCTION, recall passes, and precision (lower bound -0.062) and edit pass (0.833 → 0.833) fail.

### Localization, AFTER against BEFORE (A and B pooled, 197 runs, 20 tasks)

| Metric | Before | After | Mean change | 95% CI | Wilcoxon p | max-T p | Read |
|---|---:|---:|---:|---:|---:|---:|---|
| **Steps** (primary) | 4.88 | 3.97 | -17% | -23% to -11% | <0.001 | – | lower |
| Turns (`num_turns`) | 5.01 | 4.58 | -7% | -14% to +1% | 0.103 | 0.422 | within noise |
| Wall s | 28.65 | 23.67 | -16% | -23% to -7% | 0.001 | 0.013 | lower |
| Duration s | 28.25 | 23.17 | -16% | -24% to -8% | 0.001 | 0.007 | lower |
| API s | 24.95 | 22.33 | -8% | -16% to +1% | 0.036 | 0.432 | within noise |
| API s/step | 5.08 | 5.64 | +13% | +4% to +23% | 0.017 | 0.094 | within noise |
| Non-API s | 3.30 | 0.85 | -74% | -81% to -63% | <0.001 | <0.001 | lower |
| Cost $ | 0.17 | 0.18 | +8% | +2% to +14% | 0.021 | 0.138 | within noise |
| Cost beyond first write $ | 0.07 | 0.08 | +14% | +4% to +25% | 0.021 | 0.118 | within noise |
| Cost at 150k context $ | 0.14 | 0.14 | -3% | -10% to +3% | 0.408 | 0.900 | within noise |
| Cache read tokens | 178,377 | 151,270 | -15% | -22% to -7% | 0.007 | 0.011 | lower |
| Cache write tokens | 32,883 | 36,231 | +14% | +7% to +22% | <0.001 | 0.015 | higher |
| Output tokens | 1,869 | 1,734 | -5% | -11% to +1% | 0.048 | 0.407 | within noise |

**Per batch:**

| Batch | Steps | Wall | Cost | Other significant changes |
|---|---|---|---|---|
| A | -15% (p < 0.001) | -19% (max-T 0.041) | +8% (within noise) | cache writes +14% |
| B | -19% (p = 0.001) | -10% (within noise) | +6% (within noise) | API s/step +18%, cache reads -17% |

**Under the ceiling** (11 tasks whose BEFORE recall was below 1.0, chosen from the results, so descriptive): recall 0.629 → 0.693 (CI -0.009 to +0.139), steps -14%.

**By tag** (recall pooled):

| Tag | Tasks | Recall | CI of change |
|---|---:|---:|---:|
| secret-named | 3 | 0.76 → 0.85 | -0.08 to +0.33 |
| glob-narrow | 5 | 0.79 → 0.75 | -0.13 to +0.06 |
| truncated-read | 3 | 0.77 → 0.79 | -0.11 to +0.09 |
| auth | 3 | 0.56 → 0.60 | 0.00 to +0.08 |
| dot-config | 4 | 1.00 → 1.00 | – |
| big-repo | 1 | 1.00 → 1.00 | – |

### INSTRUCTION: tool or instruction? (batch A, 20 tasks)

| Comparison | Steps | Duration | Cost | Recall | Precision |
|---|---:|---:|---:|---:|---:|
| INSTRUCTION against BEFORE | -1% (p 0.47) | +4% | -2% | 0.799 → 0.790 | 0.558 → 0.579 |
| AFTER against INSTRUCTION | **-12%** (p 0.001) | -18% (max-T 0.059) | **+11%** (max-T 0.020, higher) | 0.790 → 0.832 | 0.579 → 0.561 |

The batching instruction alone doesn't shorten the loop. The tool does, and it also accounts for the extra cost.

### Edit tasks (batch A, 6 tasks × 2 seeds)

| Arm | Passes | Steps | Duration s | Files changed |
|---|---:|---:|---:|---:|
| BEFORE | 12/12 | 6.58 | 57.4 | 1.50 |
| INSTRUCTION | 10/12 | 6.75 | 58.7 | 1.42 |
| AFTER | 10/12 | 5.92 | 43.0 | 1.17 |

For AFTER against BEFORE, steps are -10% (within noise), duration -20% (max-T 0.188) and cost +5%. Discordant pairs: 2 where BEFORE alone passed, none the other way (McNemar p = 0.5). With 6 tasks, nothing here can reach p < 0.05.

### Long context (batch L, 4 tasks × 1 seed, about 150k tokens cached and warm)

| Metric | Before | After | Mean change |
|---|---:|---:|---:|
| Steps | 3.75 | 3.00 | -21% (3 tasks better, 0 worse) |
| Duration s | 23.7 | 20.0 | -10% |
| Cost $ | 0.13 | 0.12 | -10% |
| Cache read tokens | 724,241 | 584,845 | -21% |
| Recall | – | – | equal or better on every task |

All within noise (4 tasks; the smallest possible p is 0.125). Deep in a thread each step re-reads the context, so fewer steps start to show up in cost: this is the only setting where AFTER's cost point estimate fell.

### Failure causes seen in the transcripts

- **BEFORE: none.** Every run answered or passed.
- **INSTRUCTION: 2 edit runs.**
  - `edit-projects-added-order` s2 dropped the old fallback ordering, which broke an existing Added test.
  - `edit-sidebar-sections` s2 broke `sectionOf`.
- **AFTER: 2 edit runs,** both `edit-projects-added-order`. Each replaced the comparator so it no longer fell back to the existing added-order map. The existing test then failed, and the agent rewrote that test to match its change, so it saw a pass while the commit's tests failed. BEFORE runs kept the fallback. The same mistake appeared once in INSTRUCTION, so it isn't specific to the tool, but its "Do not re-read" clause and fewer steps are plausible contributors, unconfirmed with 2 seeds.
- **Localization: no run failed to answer once the parser was fixed.** Recall misses are mostly narrow searches. `glob-narrow` is the only tag whose recall point estimate fell (0.79 → 0.75).

### What the tool did

| | Value |
|---|---|
| Adoption | 77/79 localization AFTER runs, first tool in all 77 (`out-husky` twice went straight to Read); edits 10/12. ToolSearch never used. |
| Batching share | 77 of 258 localization calls asked more than one kind of question (30%); edits 5 of 20 (25%) |
| Zero-match share | 45 of 218 searches returned no matches (21%), 38 of them with a glob |
| Schema errors | 3 in 91 AFTER runs, all a string where an array was expected (`search` twice, `glob` once), down from 10 in v1 |
| Truncation | 75 of 258 localization results reported truncated or omitted content; median result 5,810 characters, largest 33,663 |
| Secret-named gold files | Not refused. `remote/secrets.rs`, `secret_store.rs`, `cloud_agents/credentials.rs` and `usage_keychain.rs` appeared in AFTER's results in 16 of 16 runs, against 6 of 16 for BEFORE's Bash. |
| False secrets | VS Code's source folders `src/vs/platform/secrets/` and `src/vs/workbench/services/secrets/` were skipped as secret. In Outline, `.env.sample`, `.env.test` and `.env.development` were skipped too. |
| Big repo (`vsc-search-leak`) | The tool reported `mode: index` over 20,265 files in 20 of 24 results (the other 4 scanned). Recall was 1.00 in both arms, but AFTER was slower (18 → 26 s) and dearer ($0.04 → $0.06), with `glob_warnings` for a path glob that matched nothing searchable. |


## Round 3 (batch C): pre-registration

Written on 2026-11-05 at about 16:10 EST, before any batch C run. It stays as written, and later changes go under [Batch C deviations](#batch-c-deviations).

**What changed since round 2.**
- **Engine:** replies are 41% smaller on the replay (`replay.mjs`), empty searches inside a glob now list hits outside it, and the secret filter is narrower.
- **Server build:** round 2's server was a debug test binary, which inflated tool time (median 1.2 s per call, against 134 ms for Bash). Batch C's server is built with the `fast-release` profile, which ships the app's `opt-level = "s"` without LTO. Its snapshot is `bin-c` (binary `254721c0`, sources `9bd9a574`), and every AFTER run records `server.profile` and `server.optLevel`.

**Design.** BEFORE and AFTER only, with arms, prompts, tasks, gold sets, harness (2.1.317) and isolation unchanged from round 2.

| Set | Runs |
|---|---|
| Localization | 20 tasks × 2 arms × seeds 5 and 6 (80 runs) |
| Edits | 6 tasks × 2 arms × seeds 5 and 6 (24 runs) |
| Long context | 4 tasks × 2 arms × 1 seed (8 runs) |

Arm order and run order come from batch C's own recorded seed. If the budget allows afterwards, batch B's 12 missing edit runs follow on B's own (round 2) snapshot. They count only toward round 2.

**Primary metric and gates: as in round 2, judged on batch C alone.** There is no pooling with round 2 runs, because the engine differs.
- **Primary:** steps on localization, AFTER against BEFORE. It reads as lower only if Wilcoxon p < 0.05 and the CI excludes zero.
- **Gate:** non-inferiority with a margin of -0.05 on localization recall, precision and edit pass rate. The lower bound of the 95% CI of the mean per-task change must clear the margin.
- **Other metrics:** one max-T family, as before.
- **Named secondary: cost** (`total_cost_usd`). It is reported with its own CI, Wilcoxon p and max-T p. It has no gate.
- **Descriptive only:** cache writes per step after the first, compared with round 2's AFTER per task.

**Budget.** The total is raised to **$80**, counting the $51.95 already in the ledger ($47.95 billed and $4 charged). The cap check, the 6 GiB disk floor, the wait behaviour and recording PIDs are unchanged.

### Batch C deviations

1. **Server build.** The optimized server was built on a RAM disk, which was ejected afterwards, so the build never touched the shared disk.
2. **Smoke test (`--snapshot bin-c --arm before,after --no-long`).**
   - AFTER: the tool was connected, listed and called directly (3 calls, no ToolSearch). The probe quoted exactly the explore clause.
   - BEFORE: no MCP tools and no hooks, and its localization run passed. Its instruction probe returned no visible text (the result was empty), so it was repeated.
3. **Batch C has not started (`C-not-run`).** The shared disk fell to 1.7 GiB free because of other tasks (this benchmark's files total 935 MiB), so the repeated probe waited without starting a checkout and was stopped by its recorded PID. No batch C data exists yet.

  Resume, once free space is above 6 GiB, with `node scripts/agent-bench/run.mjs --batch C --snapshot bin-c --set loc,edit --arm before,after --seeds 5,6 --total-budget-usd 80`, then `--batch C --snapshot bin-c --set long --total-budget-usd 80`.

4. **Batch D replaces batch C, which never ran.** The architect held C at about 16:40 EST because council round 2 found engine changes (secret rules, hit trimming, a lexer case, an unbounded `ambiguous` list, and the bench server's argument path, which now calls `run_checked` like the app). Round 4 changed hit ranking, the budget, secret rules and the lexer again; replay bytes are -4.7% against round 3 with no gold lost.
   - Batch D runs on a new optimized snapshot, `bin-d` (`fast-release`, built from the round 4 tree), under **this pre-registration unchanged**. Everything said above about C applies to D.
   - `bin-c` was never used for a measured run; its BEFORE/AFTER smoke runs are kept separate in `runs/smoke-bin-c`.
   - The RAM disk used for `bin-c` couldn't be made this time (the DiskManagement framework was unavailable), so `bin-d` was built in this benchmark's own directory and its build was deleted afterwards. That was done while 23 GiB were free.
   - Disk rules for D, decided before any D run:
     - Wait up to 90 minutes, checking every 2 minutes, for 6 GiB free; then run the full plan.
     - If free space is between 3 and 6 GiB after that, run only localization and long context, at concurrency 2 with a 3 GiB floor, and mark edits "not run (disk)".
     - Under 3 GiB, run nothing.
5. **Batch D has not started (`D-not-run`).** `bin-d` was built at 21:05 EST: `fast-release`, opt-level `s`, binary `256be939`, sources `1f267ae6`. Free space was then 24 GiB, so the disk rules allowed the full plan.
   - The smoke test (`--snapshot bin-d --arm before,after --no-long`) found the harness signed out: both runs answered "Not logged in · Please run /login" and billed $0. `claude auth status` reports `loggedIn: false` for both 2.1.317 and 2.1.318.
   - On this machine the Keychain search list, DiskManagement and `sysmond` were unavailable at the same time.
   - Signing in is the user's decision, so nothing more ran. AFTER's MCP server connected and the tool was listed, so the snapshot itself is ready.
   - Resume after sign-in:
     1. `node scripts/agent-bench/run.mjs --smoke --snapshot bin-d --arm before,after --no-long --force --total-budget-usd 80`
     2. `--batch D --snapshot bin-d --set loc,edit --arm before,after --seeds 5,6 --total-budget-usd 80`
     3. `--batch D --snapshot bin-d --set long --total-budget-usd 80`

     Steps 2 and 3 use `node scripts/agent-bench/run.mjs` like step 1, under the disk rules above.

## Batch D results (round 4 engine, optimized server)

Sonnet, 2026-11-05/06, explore snapshot `bin-d` (`fast-release`, opt-level `s`, binary `256be939`, sources `1f267ae6`). The snapshot was checked against the current tree before the run, and it was built after `explore_host` moved to `run_checked`. Smoke test: AFTER called the tool directly in 3 calls, with no ToolSearch, and quoted only the explore clause. BEFORE had no MCP tools and no explore clause.

**What ran:**
- Localization: 80 of 80 runs.
- Edits: 24 of 24 runs.
- Long context: 5 of 8. The $80 cap stopped the rest: `loc-cloud-credentials` BEFORE and `loc-model-picker-errors` in both arms did not run.
- Batch B's 12 missing edit runs: **not run (budget)**.

**Interruptions.**
- Mid-batch, a checkout's cleanup hit `ENOTEMPTY`: a tool the agent started was still writing into the big VS Code tree. That ended the runner.
- The next start stopped the 1 recorded process still running and charged the 4 runs in flight at their caps ($4). They were then rerun, and the killed attempts count for neither arm.
- Cleanup failures no longer end a batch; they are logged on the run instead.

### Gates (batch D alone; the lower bound must clear -0.05)

| Measure | Before | After | CI of change | Result |
|---|---:|---:|---:|---|
| Recall | 0.797 | 0.824 | -0.029 to +0.088 | pass |
| Precision | 0.573 | 0.524 | -0.093 to -0.003 | **fail** (and lower: the whole CI is below zero) |
| Edit pass | 1.000 | 0.917 | -0.250 to 0.000 | **fail** |

**Not shown non-inferior.**
- **Precision.** AFTER listed more files per answer (6.85 against 6.10) for about the same gold hits (3.23 against 3.15). The largest drops were in `vsc-search-leak`, `out-auth-transports`, `loc-usage-keychain`, `out-lint-sanitize` and `loc-team-stop`.
- **Edit pass.** The one discordant pair is `edit-sidebar-sections` s5: AFTER broke `sectionOf`, the same failure the INSTRUCTION arm had in round 2.

### Before vs after

**Localization** (80 runs, 20 tasks):

| Metric | Before | After | Mean change | 95% CI | Wilcoxon p | max-T p | Read |
|---|---:|---:|---:|---:|---:|---:|---|
| **Steps** (primary) | 5.05 | 4.33 | -13% | -21% to -5% | 0.005 | – | lower |
| Wall s | 23.50 | 21.08 | -8% | -14% to -2% | 0.014 | 0.078 | within noise |
| Duration s | 23.16 | 20.65 | -9% | -15% to -3% | 0.008 | 0.062 | within noise |
| API s/step | 4.22 | 4.75 | +14% | +6% to +22% | 0.003 | 0.024 | higher |
| Non-API s | 1.70 | 0.49 | -70% | -80% to -57% | <0.001 | <0.001 | lower |
| **Cost $** (named secondary) | 0.17 | 0.17 | +1% | -3% to +7% | 0.571 | 0.994 | within noise |
| Cost at 150k context $ | 0.15 | 0.14 | -8% | -14% to -1% | 0.036 | 0.206 | within noise |
| Cache read tokens | 188,088 | 160,764 | -13% | -23% to -3% | 0.024 | 0.103 | within noise |
| Cache write tokens | 32,848 | 33,108 | +4% | -1% to +10% | 0.708 | 0.732 | within noise |
| Cache write tokens per step after the first (descriptive) | 1,874 | 2,428 | +38% | +14% to +67% | 0.003 | – | higher |

**Edits** (24 runs, 6 tasks):
- Steps 6.50 → 5.67 (-11%, CI -18% to -5%, p = 0.063: within noise; 1 task tied, leaving 5, so the smallest possible p was 0.0625).
- Duration 65.2 → 44.6 s (-17%) and cost +0%, both within noise.
- Cache writes per step after the first: +38% (descriptive).
- Passes 12/12 → 11/12; files changed 1.33 → 1.17.

**Long context** (2 complete pairs and 1 AFTER-only run; descriptive):
- `loc-skill-brief`: steps 8 → 6, cost $0.27 → $0.21, recall 1.00 → 0.75.
- `loc-connect-keychain`: steps 3 → 3, recall 0.67 → 1.00.

### Against round 2's AFTER (descriptive: different engine, seeds and day; means over runs)

| AFTER localization | v2 (A+B, 79 runs) | D (40 runs) |
|---|---:|---:|
| Steps | 3.96 | 4.33 |
| Wall s | 23.7 | 21.1 |
| Duration s | 23.2 | 20.7 |
| Non-API s | 0.84 | 0.49 |
| Cost $ | 0.178 | 0.167 |
| Cache write tokens per step after the first | 3,643 | 2,428 |
| Median explore reply (characters, over replies) | 5,811 (258 replies) | 3,067 (130 replies) |
| Recall | 0.817 | 0.824 |
| Precision | 0.552 | 0.524 |

An earlier version of this table gave 7,745 and 4,367 characters for the median reply; no source for those figures could be found, so they were replaced by the medians computed from the per-run CSVs. The smaller replies show up as a third fewer later cache writes and lower cost per AFTER run. The step saving against BEFORE narrowed from -17% (round 2) to -13%. BEFORE took 5.05 steps in D, against 4.88 in round 2.

**Under the ceiling** (12 tasks whose BEFORE recall was below 1.0, chosen from the results, so descriptive): recall 0.662 → 0.707 (CI of change -0.049 to +0.144), steps -15% (CI -25% to -5%, p = 0.031).

**By tag** (recall; descriptive, 1 to 5 tasks per tag):

| Tag | Tasks | Recall | CI of change |
|---|---:|---:|---:|
| secret-named | 3 | 0.78 → 0.86 | -0.08 to +0.33 |
| glob-narrow | 5 | 0.79 → 0.76 | -0.13 to +0.06 |
| truncated-read | 3 | 0.71 → 0.75 | -0.13 to +0.25 |
| auth | 3 | 0.58 → 0.61 | 0.00 to +0.08 |
| dot-config | 4 | 1.00 → 1.00 | – |
| big-repo | 1 | 1.00 → 1.00 | – |

As in round 2, `glob-narrow` is the only tag whose recall point estimate fell.

### What the tool did (batch D)

| | Value |
|---|---|
| Adoption | localization 38/40, first tool every time (`out-husky` went straight to Read twice); edits 11/12; ToolSearch never |
| Multi-kind calls | 49 of 130 (38%, up from 30% in round 2); edits 7 of 23 |
| Empty searches | 22 of 132 (17%, down from 21%), 17 of them with a glob |
| Outside-glob listings | 140 replies carried an `outside_glob` listing (hits outside the glob), most of them for globs that also had hits inside; in 43 the agent later used one of the listed paths. This is a count of listings, not of empty searches. |
| Schema errors | 0 (3 in round 2) |
| Truncated or omitted | 91 of 130 localization replies reported trimmed hits, as the new per-file caps intend; median reply 3,067 characters, largest 16,371 |
| VS Code (`vsc-search-leak`) | AFTER 3.5 steps (BEFORE 5.0), duration 17 s in both arms, non-API time 1.2–1.5 s (2.2–10.5 s with round 2's debug server), recall 1.00 in both arms, cost $0.07 against $0.05 |

### Failure causes by arm (batch D)

- **BEFORE:** none.
- **AFTER:** 1 edit run. `edit-sidebar-sections` s5 rewrote `src/sidebar-sections.ts` so that `sectionOf` no longer mapped groups the way the commit's tests expect, failing two tests.
- **Precision:** the agent named extra, related files more often with the tool. No run failed to answer.

### Spend

| | Amount |
|---|---:|
| Ledger total | $78.16 of $80 |
| Billed | $70.16 |
| Charged as caps for killed runs (round 2: 4, batch D: 4) | $8.00 |
| Batch D, smoke test included | about $22 billed |

Sanitized numbers are in `scripts/agent-bench/results/v4-D-*.json`, and per-run numbers in `results/runs/v4-D.csv`.

## Round 1 (v1), corrected

Measured on 2026-11-04 with Claude Code 2.1.317 on PandaCode at `df884aa`, comparing BEFORE and AFTER. All numbers are re-derived from the transcripts with the corrected metrics. Summaries are in `scripts/agent-bench/results/`.

### Bottom line

- **The loop got shorter on localization.** Steps fell 25% in the clean batch and 10% in the first batch, or **18% pooled (CI -28% to -9%, p = 0.008, 8 of 8 tasks)**. Duration fell 17% pooled (corrected p = 0.023).
- **Each step got slower.** API time per step rose 13% in the clean batch (within noise after correction). API time as a whole is within noise, so the fewer steps were largely offset.
- **It did not save money.** Cost is within noise in every view. About 68% of a localization run's cost is the first cache write of 31,823 tokens, which is the same in both arms, and later writes grew.
- **Quality is not shown non-inferior.** Under the gate now pre-registered, v1 **fails** for recall and precision in every batch, because the CIs are too wide: pooled recall is 0.833 → 0.840 with a lower bound of -0.104. The earlier report's "passes" compared point estimates only. In the first batch, the point estimate was worse too (0.844 → 0.833).
- **Edit tasks show nothing either way.** Steps are -12% and within noise, and passes are 10/10 in both arms, with tasks too weak to detect much.

### Corrections to the earlier report

| Earlier claim | Correction |
|---|---|
| Turns are the step count | `num_turns` also counts parallel tool messages, which penalises AFTER. Steps are distinct model requests; their sum of cache reads matches each run's `result` exactly. |
| Turn savings did not replicate | Steps do: -25% and -10% in the two batches, -18% pooled. |
| Opus turns halved (9.3 → 4.8) | An artifact of the same counter. Opus steps went 5.00 → 4.25, with 2 of 4 tasks better and none worse. |
| Cache reads hold up after pooling | Not after correction across metrics: max-T p = 0.102 pooled, 0.016 in the clean batch alone. |
| Wall time -20% is significant | Uncorrected only: max-T p = 0.063. Duration pooled is the better-supported figure. |
| The regression gate passes | Under the non-inferiority gate it fails (see above). |
| Later cache writes 1,749 → 4,007 per step | That mixed tasks and was unweighted. Clean-batch localization is 1,624 → 3,109 step-weighted, median 1,233 → 1,652. |
| "Neither arm called Grep or Glob" | They aren't in `init.tools` on this harness, so the baseline is Bash-only. |
| Edit needs its own Read, so explore's `read` can't satisfy it | **Retracted.** 36 Sonnet Edits in AFTER across both batches had no refusals, and Opus made 4 Edits after explore reads only. The extra Reads are the model's habit, not a harness rule. |
| Files "read" for partial credit | The old rule used every Bash word in BEFORE but only outline and read paths in AFTER. Credit now uses any tool input or output, the same in every arm. |
| Arm order randomized | It came from a fixed hash, so it was the same on every rerun. Round 2 uses a recorded per-batch seed. |
| Two runs' metrics | Those two runs reported two `result` events, and only the last was read. Per-segment values now add up, and the cost, which is cumulative, comes from the last. Both are BEFORE edit runs in the discarded batch. |

### Localization, Sonnet

**Clean batch** (48 runs, 8 tasks):

| Metric | Before | After | Median change | Mean change | 95% CI | Wilcoxon p | max-T p | Better / worse | Read |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| **Steps** (primary) | 4.92 | 3.75 | -29% | -25% | -32% to -16% | 0.008 | – | 8 / 0 | lower |
| Turns (`num_turns`) | 5.04 | 4.25 | -11% | -16% | -28% to -5% | 0.031 | 0.164 | 6 / 1 | within noise |
| Wall s | 25.14 | 19.81 | -20% | -20% | -30% to -10% | 0.023 | 0.063 | 7 / 1 | within noise |
| Duration s | 24.84 | 19.36 | -21% | -21% | -31% to -11% | 0.016 | 0.055 | 7 / 1 | within noise |
| API s | 22.95 | 18.96 | -17% | -16% | -26% to -6% | 0.039 | 0.117 | 7 / 1 | within noise |
| API s/step | 4.78 | 5.42 | +16% | +13% | +2% to +24% | 0.055 | 0.242 | 1 / 7 | within noise |
| Non-API s | 1.89 | 0.40 | -67% | -67% | -81% to -52% | 0.008 | 0.008 | 8 / 0 | lower |
| Cost $ | 0.19 | 0.19 | +2% | +2% | -5% to +11% | 0.945 | 0.992 | 4 / 4 | within noise |
| Cost beyond first write $ | 0.06 | 0.06 | +7% | +11% | -14% to +41% | 0.945 | 0.961 | 4 / 4 | within noise |
| Cost at 150k context $ | 0.14 | 0.12 | -13% | -8% | -22% to +7% | 0.250 | 0.797 | 5 / 3 | within noise |
| Cache read tokens | 191,254 | 140,931 | -34% | -28% | -39% to -16% | 0.008 | 0.016 | 8 / 0 | lower |
| Cache write tokens | 38,184 | 40,373 | +6% | +6% | -2% to +15% | 0.250 | 0.641 | 3 / 5 | within noise |
| Output tokens | 1,613 | 1,520 | -2% | -5% | -13% to +1% | 0.250 | 0.633 | 5 / 3 | within noise |

**Both batches pooled** (96 runs, 6 seeds per task). Wall time is left out, because a runner bug inflated it in the first batch. Duration comes from the harness and isn't affected.

| Metric | Before | After | Median change | Mean change | 95% CI | Wilcoxon p | max-T p | Better / worse | Read |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| **Steps** (primary) | 4.85 | 4.08 | -14% | -18% | -28% to -9% | 0.008 | – | 8 / 0 | lower |
| Turns (`num_turns`) | 4.94 | 4.54 | -7% | -10% | -21% to 0% | 0.156 | 0.500 | 5 / 2 | within noise |
| Duration s | 25.51 | 21.46 | -17% | -17% | -25% to -9% | 0.016 | 0.023 | 7 / 1 | lower |
| API s | 23.07 | 20.87 | -10% | -11% | -18% to -4% | 0.078 | 0.109 | 7 / 1 | within noise |
| API s/step | 4.91 | 5.41 | +6% | +11% | +1% to +20% | 0.195 | 0.375 | 2 / 6 | within noise |
| Non-API s | 2.44 | 0.59 | -83% | -74% | -87% to -58% | 0.008 | 0.008 | 8 / 0 | lower |
| Cost $ | 0.19 | 0.19 | -1% | +2% | -2% to +7% | 0.844 | 0.945 | 5 / 3 | within noise |
| Cost beyond first write $ | 0.06 | 0.06 | -2% | +8% | -6% to +25% | 0.844 | 0.875 | 5 / 3 | within noise |
| Cost at 150k context $ | 0.14 | 0.13 | -7% | -6% | -14% to +2% | 0.195 | 0.711 | 5 / 3 | within noise |
| Cache read tokens | 188,860 | 156,988 | -17% | -21% | -34% to -9% | 0.016 | 0.102 | 7 / 1 | within noise |
| Cache write tokens | 38,304 | 40,105 | +5% | +5% | 0% to +11% | 0.109 | 0.477 | 3 / 5 | within noise |
| Output tokens | 1,635 | 1,581 | -4% | -3% | -9% to +2% | 0.461 | 0.859 | 5 / 3 | within noise |

"Cost at 150k context" is arithmetic on measured steps, assuming that context is already cached and warm. It isn't a run; round 2's long-context batch measures it. The prices are fitted to observed costs, with a median error under 0.001%: $4/M write, $0.10/M read, $10/M output on Sonnet.

**Gate, as now pre-registered** (lower bound must clear -0.05):

| Batch | Recall | CI of change | Precision | CI of change | Result |
|---|---:|---:|---:|---:|---|
| Clean | 0.823 → 0.847 | -0.101 to +0.139 | 0.431 → 0.399 | -0.114 to +0.040 | **fail** |
| First | 0.844 → 0.833 | -0.125 to +0.115 | 0.388 → 0.416 | -0.059 to +0.113 | **fail** |
| Pooled | 0.833 → 0.840 | -0.104 to +0.097 | 0.409 → 0.408 | -0.082 to +0.074 | **fail** |

4 of the 8 tasks sit at the recall ceiling, leaving 4 tasks that can move recall, with a smallest possible p of 0.125.

| Task (pooled) | Steps | Duration s | Cost $ | Recall |
|---|---:|---:|---:|---:|
| `loc-cloud-credentials` | 7.3 → 7.2 | 34 → 36 | 0.22 → 0.22 | 0.54 → 0.63 |
| `loc-model-picker-errors` | 6.8 → 5.3 | 31 → 26 | 0.19 → 0.19 | 0.67 → 0.89 |
| `loc-opencode-models` | 4.5 → 4.0 | 25 → 20 | 0.18 → 0.19 | 0.75 → 0.83 |
| `loc-project-relink` | 5.0 → 4.8 | 23 → 21 | 0.19 → 0.20 | 1.00 → 1.00 |
| `loc-remote-journal` | 3.7 → 2.0 | 19 → 13 | 0.18 → 0.17 | 1.00 → 1.00 |
| `loc-schedule-messages` | 3.2 → 2.2 | 20 → 16 | 0.17 → 0.20 | 1.00 → 1.00 |
| `loc-skill-activation` | 4.0 → 3.5 | 25 → 22 | 0.19 → 0.18 | 0.71 → 0.38 |
| `loc-streaming-markdown` | 4.3 → 3.7 | 26 → 18 | 0.19 → 0.18 | 1.00 → 1.00 |

### Edit tasks, Sonnet (clean batch, 20 runs, 5 tasks)

Every metric is within noise, and with 5 tasks the smallest possible Wilcoxon p is 0.0625. Passes are 10/10 in both arms, with no discordant pairs, and both arms changed 1.8 files per run.

| Metric | Before | After | Mean change | 95% CI | Wilcoxon p | max-T p |
|---|---:|---:|---:|---:|---:|---:|
| **Steps** | 6.60 | 5.70 | -12% | -26% to +1% | 0.375 | – |
| Turns (`num_turns`) | 7.20 | 8.00 | +13% | -8% to +31% | 0.625 | 0.813 |
| Duration s | 63.28 | 56.65 | -9% | -24% to +5% | 0.813 | 0.813 |
| API s | 26.35 | 26.43 | +2% | -10% to +15% | 1.000 | 1.000 |
| API s/step | 4.13 | 4.89 | +19% | +5% to +34% | 0.125 | 0.500 |
| Cost $ | 0.14 | 0.14 | -3% | -10% to +4% | 0.438 | 1.000 |

These tasks were weak: all five failed before the fix on a missing symbol, not an assertion, and two covered only a new helper.

### Opus (descriptive, 12 runs)

4 localization and 2 edit tasks at one seed. Nothing can reach significance, and the gate fails on recall (0.750 → 0.667, lower bound -0.250).

| Metric | Localization | Edit |
|---|---:|---:|
| Steps | 5.00 → 4.25 | 8.00 → 9.00 |
| Duration s | 44.8 → 39.3 | 242 → 216 |
| Passes | – | 2/2 → 2/2 |

### No model

`explore_bench` at the pinned commit (1,397 files, p50, on a 16-core machine): walk 9.6 ms, index build 119 ms, symbol lookup 75.9 ms, batch of 5 patterns and a symbol 305.7 ms. `rg --count` took about 20–40 ms per pattern. The scan took 28–218 ms, and the index 13–212 ms, beating `rg` only on a few literals. `rg --count` does less work, since it returns no lines. Local search time isn't what limits the loop: non-API time is under 3 s per run in either arm.

### Observed causes

From the transcripts, using `scripts/agent-bench/dig.mjs`. Fixes are proposals, and these findings are for the snapshot tested, not the current tool.

1. **Almost every call asks one kind of question.** 78 of 86 Sonnet calls in the clean batch used a single kind (a search, or a read, and so on), so the tool's batching mostly goes unused.
2. **Globs return nothing.** 20 of 72 clean-batch searches returned no matches, all with a glob. This is the most likely driver of narrow searches, such as `loc-skill-activation`'s recall of 0.38, where the missed files never appeared in results.
3. **Opaque schema errors.** Sonnet passed `search` or `glob` as a string 10 times across 4 of 34 AFTER runs, and the reply was only `Invalid argument: glob`.
4. **Larger outputs.** Later cache writes nearly doubled step-weighted (1,624 → 3,109), with single results up to about 35,000 characters.
5. **Nothing to explore.** Both `edit-connect-secrets` AFTER runs went straight to Read, because the prompt made the file obvious. This is not a defect.

### Method and limits (v1)

- 8 localization tasks at 3 seeds and 5 edit tasks at 2 seeds, with 2 arms, on one repo. Gold sets came from logs, and 3 of the 8 could not be traced to a commit later.
- Isolation was checked on real runs: only three built-in plugins, the same 17 skills in both arms, no hook events, and the instruction present only in AFTER.
- The first full Sonnet batch (68 runs) had a runner bug that blocked the event loop during grading and inflated wall time. Its recipe task also failed both arms for an unrelated reason. Its localization steps, duration, API time, cost and recall are unaffected and are used above as a replicate; its wall time and edit runs are not.
- 4 runs that were in flight when an earlier start was stopped were deleted and rerun. They count for neither arm.
- Spend was about $32 across 148 runs.
