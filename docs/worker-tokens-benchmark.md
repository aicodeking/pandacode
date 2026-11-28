# Worker tokens: S2 corrections and batch S3

This page holds the benchmark side of [Where a team worker's tokens go](worker-tokens.md): round 18's corrections to batch S2, and batch S3, which measures round 18's worker launch on a setup with a real skills library.

**Registration is local only.** Each pre-registration and deviation is appended to `scripts/agent-bench/results/preregistrations.jsonl` with the sha256 of its section, the pinned files, the analysis code and the line before it, and `check.test.mjs` fails if any of them changes. The times come from this computer's clock, and nothing is published outside the repo when it is written. The chain shows that a text did not change after its entry. It cannot prove when the entry was made.

<!-- deviation:S2-1 -->
### S2 corrections (round 18, deviation S2-1)

**POST-HOC: written on 2026-11-07, after S2's results were known (council round 15).** Nothing here changes S2's registered verdicts: billed cost is still not shown to be lower, first-step cache write is still lower, and input plus cache tokens is still not shown to be lower.

1. **Tool counts were wrong.** The S2 write-up said LEAN made 39 Bash searches against BASE's 23, with 68 explore calls in each arm. The counts are below. `s2.mjs --analyze --tools` derives them from each run's `tools` counter (`metrics.mjs`, the main agent's `tool_use` blocks only; Bash is `BashSearch` plus `BashOther`), and a count of `Bash` and `pandacode_explore` blocks in the raw transcripts gives the same numbers. Summary: `scripts/agent-bench/results/s2-S2-tools.json`.

   | Main-agent calls, 84 runs per arm | BASE | LEAN |
   |---|---:|---:|
   | `pandacode_explore` | 194 | 183 |
   | Bash (search + other) | 51 (42 + 9) | 92 (83 + 9) |
   | Runs with any Bash call | 26 | 43 |

   LEAN moved searches from explore to Bash: 41 more Bash calls in 17 more runs. This is descriptive. Nothing about tool use was registered.

2. **Probe numbers and S2's own measurements were mixed.** The probe table in `worker-tokens.md` comes from single `claude -p "Reply with the single word ok"` runs. S2 measured these on its own runs, means over 84 runs per arm, descriptive:
   - First-step cache reads: 10,967 → 6,261 tokens. This is the same in every run of an arm. The tool prefix that LEAN no longer sends is 4.7k tokens, not the 5.4k of the probe.
   - Cache reads per step (total cache reads over total steps): 32.7k → 28.8k.

   The claim that the trim saves "roughly 2–4% of billed cost" is withdrawn. It was an estimate from probes, and S2 measured −1.8% (CI −4.4% to +1.0%, not shown).

   **S2 ran without user settings.** Its runs used `--setting-sources project`, so no user skills, hooks, plugins or rules were loaded: only Claude Code's 17 bundled skills were listed. On a real install the listing is longer, so the real-world effect of a launch change differs from S2's. Batch S3 (below) measures it with a copy of a real skills library.

3. **S2's report answers, rescored with the strict rubrics** (`results/s1v3-strict-rubrics.json`, from S1v3-2), as a descriptive sensitivity check: `s2.mjs --analyze --strict-rubrics results/s1v3-strict-rubrics.json`, summary `results/s2-S2-strict.json`. The scorer sees only the answer and the rubric.

   | Report rubric recall, 8 tasks | BASE | LEAN | Difference | 95% CI |
   |---|---:|---:|---:|---:|
   | Registered rubrics (S2 as published) | 0.925 | 0.912 | −0.013 | −0.089 to +0.057 |
   | Strict rubrics | 0.899 | 0.906 | +0.008 | −0.073 to +0.083 |

   The strict patterns lowered some answers in both arms (unlike S1v3, where they found no case). The difference between the arms stays within ±0.015 and both CIs span 0. The circularity noted for S1v3 applies here too: two strict patterns were loosened after they were seen to reject correct units in S1v3's answers.

4. **"Cache reads are nearly 90% of the tokens"** (the breakdown in `worker-tokens.md`) is 81% for S1v3 (144k of 177k) and 87% for Fv2 (193k of 221k), counting cache writes, cache reads and output.

5. **S2's test and its CI used different scales.** The Wilcoxon test ran on per-task absolute differences, and the CI was the bootstrap of the mean per-task relative change. They can disagree near the margin, as they did for input and cache tokens (CI excluded 0, Holm p = 0.057). **From S3 on, both are on the log-ratio scale:** per unit d = log(mean NEW / mean BASE) over seeds, the Wilcoxon test on d and the bootstrap CI of the mean of d, reported as exp(mean d) − 1.

6. **`s2.mjs` changed after S2 ran.** Round 18 removed code that duplicated `saver.mjs` (`checkout`, `assignJobs`) and added `--tools` and `--strict-rubrics` to `--analyze`. The registered analysis (`analyze()` in `s2.mjs`) did not change. Rerun on S2's runs, it gives the published summary number for number. Each S2 run keeps the runner hash it was made with. This entry supersedes S2's pin on `s2.mjs`. It pins `tasks-s2.json`, `tasks-saver.json` and `tasks.json` again, which have not changed.
<!-- /deviation:S2-1 -->

Other round 18 wording fixes, outside this page:
- [agent-loop-benchmark.md](agent-loop-benchmark.md): Fv2's held-out table reads "descriptive" where it said "lower" and "gate: pass". The Fv2-2 reading rule now calls the edit pass gates' passes weak evidence. They pass 26% and 10% of no-effect batches, so they are not "real evidence against a large loss".
- [token-saver-benchmark.md](token-saver-benchmark.md): the S1v3 strict-rubric rescoring says "the strict patterns found no case" and notes that two patterns were loosened on the same answers.
- The runner (`scripts/agent-bench/`): `noEffectGate` now uses `simulateNonInferior`, the simulator behind Fv2-2. S1v3's no-effect pass rates came out the same (0.78, 0.93, 0.95). `blindRescore` is a plain map. New runner tests cover the disk hold, the one-hour give-up, `aborted()`, skipped runs, the exit code, `measuredRun`'s cleanup and `claimRunner`.

## Batch S3: round 18's worker launch with a real skills library

<!-- prereg:S3 -->
### Pre-registration: batch S3

Written on 2026-11-07, after one smoke (`loc-agent-env` and `rep-explain-queue`, both worker kinds, both arms, seed 99, 8 runs, $2.25 billed; runs in `~/Library/Caches/pandacode-bench/s3/runs/smoke-S3`, never analysed with S3) and before any S3 run.

**Question.** On a setup with a real skills library, does round 18's team worker launch (NEW) bill less than the launch before it (BASE), for read-only and writer workers?

**Common to both arms.** Claude Code 2.1.317, worker model `sonnet` pinned to `claude-sonnet-5-5`, the explore snapshot `bin-f`, `LOOK` appended with `--append-system-prompt`, and the message `<report sentence>\n\n<task prompt>` with no token-saver block (the brief's "inherited saver block absent"). Both run with `--setting-sources project` and `--add-dir <out>/skills-home`, which holds a copy of this user's `~/.claude/skills` (35 entries, one dangling link left out; sha256 of paths and contents pinned in `batch.json`) and nothing else: no settings, hooks, plugins, rules or memory.
- **Why `--add-dir` and not a synthetic `CLAUDE_CONFIG_DIR`.** A probe with a synthetic config dir answered "Not logged in": this harness keys its macOS keychain login to the config dir, and copying the login would put a live token on disk and could rotate the user's own. With `--add-dir`, the pinned harness lists the copied skills under their own names, as user skills are listed: the probe went from 19 to 42 listed skills and from 4.1k to 10.3k first-request write tokens. In the smoke, every run's `init` event named 51 skills (bundled plus copied), NEW's too. With `Skill` denied the listing is not sent, which shows in NEW's smaller first-step write. Plugin skills of the real install are not included.

**Arms.** They differ in three things:

| | BASE (before round 18) | NEW (round 18) |
|---|---|---|
| `--disallowedTools` | S2's LEAN lists (`s3.mjs` `PRE_R18`, sha256 equal to S2's `lists` pin): session-bound, worker list with `TaskStop`, plus `Edit,Write,NotebookEdit` for read-only workers. `Skill` on. | `claude_disallowed_tools(Some(WorkerTrim { read_only, skills: false }))`, read from `providers.rs` at run time: session-bound, worker list without `TaskStop`, `Edit,Write,NotebookEdit` for read-only workers, then `Skill`. |
| MCP server | bin-f's `custom_tools_mcp_serve`: `pandacode_explore` plus `pandacode_tool_list`, `_save` and `_run` with their full descriptions, over an empty per-run store, so no Project tools note | bin-f's `explore_mcp_serve`: `pandacode_explore` only |
| Instructions | `LOOK`, then `REUSE` from `lib.rs` | `LOOK` |

Not modelled: the old worker instructions ended with the token saver's subagent sentence, which round 18 removed. It is one sentence in the cached system prompt. Nothing else in the app instructions is sent by the benchmark in either arm.

Each run checks its own launch from its `init` event and stops the batch if it is wrong (`launchProblem`): BASE must list `Skill`, at least one copied skill and all three agent-made tools; NEW must list neither.

**Tasks.** S2's 28 tasks (`tasks-s2.json`: 20 localization and 8 report tasks), each run twice: as a read-only worker (`ro`) and as a writer (`rw`). That gives 56 units (task × worker kind). Grading is as in S2.

**Seeds.** 1, 2 and 3 for each arm and unit: 336 runs. Job and arm order come from the batch seed in `batch.json`.

**Primary.** Billed cost per run, BASE → NEW. Per unit, d = log(mean NEW / mean BASE) over seeds. A two-sided Wilcoxon signed-rank test on d (`stats.mjs`, exact to 17 units, else 200,000 sampled sign flips) and a 95% bootstrap CI of mean d, both on this scale (deviation S2-1, point 5). Reported as exp(mean d) − 1. Cost is read as lower only if p < 0.05 and the CI's upper end is below 0.

**Secondary,** on the same scale, Holm-adjusted together:
- first-step cache-write tokens;
- steps.

**Descriptive:** output tokens, cache-read tokens, wall time, cost per worker kind, tool calls (`toolCounts`), listed tools and skills.

**Quality,** descriptive, with no gate: localization recall and precision, and report rubric recall, each as the mean per-unit difference with a 95% bootstrap CI. Report recall is also given rescored with the strict rubrics (`results/s1v3-strict-rubrics.json`).

**Power.** `s3.mjs --power` simulates S3's design from S2's runs: each unit draws its seeds' costs with replacement from one S2 task's six runs (both arms pooled), NEW's are multiplied by (1 + effect), and a normal per-unit spread τ is added on the log scale. τ = 0.042 makes the simulated sd of d match S2's observed 0.072. The rule is the primary's, with the normal approximation of the Wilcoxon test for speed (within 0.01 of the sampled test at n = 56, `s3.test.mjs`). 400 simulated batches per cell.

| P(cost reads lower) | τ = 0.042 | τ = 0.084 |
|---|---:|---:|
| No effect, 1 / 2 / 3 seeds | 0.03 / 0.01 / 0.03 | 0.03 / 0.02 / 0.03 |
| −5%, 1 / 2 / 3 seeds | 0.95 / 0.99 / 1.00 | 0.82 / 0.94 / 0.96 |
| −10%, 1 / 2 / 3 seeds | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 |

One seed already gives 80% power at −10%. We run 3, as the brief asked: they keep 96% power at −5% under twice S2's spread and give the secondaries and the quality numbers more runs.

**Exclusions.** We exclude only runs whose `init.model` is not the pinned model. A run that errors or times out keeps its tokens and its grade.

**Expectation, written down before running:** cost −10% to −20%. In the smoke BASE wrote 3.8k–9.2k more first-step tokens than NEW, and the copied skill listing is about 6k tokens. Steps: no change.

**Cost.** About $95 at $0.28 a run (the smoke's mean). The user approved unlimited spend.

**Commands.**

```sh
S3="node scripts/agent-bench/s3.mjs"
$S3 --copy-skills                               # once: copies ~/.claude/skills into <out>/skills-home
$S3 --power                                     # the table above; no model time
$S3 --register                                  # appends this section's sha256 to results/preregistrations.jsonl
$S3 --batch S3 --concurrency 4 --min-free-gib 4
$S3 --analyze --summary scripts/agent-bench/results/s3-S3.json --csv scripts/agent-bench/results/runs/s3-S3.csv
$S3 --analyze --strict-rubrics scripts/agent-bench/results/s1v3-strict-rubrics.json --summary scripts/agent-bench/results/s3-S3-strict.json
```

`--min-free-gib 4`: S3 runs no edits, and other tasks' builds on this disk left 4–12 GiB free during the smoke. run.mjs allows 3 without edits, and `s3.mjs` refuses less.
<!-- /prereg:S3 -->

## Batch S3 results

**In one line (corrected in round 19, deviation S3-1, post-hoc):** NEW saves about **$0.037 per worker run** (95% CI $0.034 to $0.040), and 91% of that ($0.034) is the first-step cache write. The mean bill falls from $0.1811 to $0.1439, a **−20.5% ratio of means** (CI −23.4% to −18.0%). The registered estimand, the geometric mean of the per-unit ratios, is −26.6%. It weights cheap units more, so it is the larger number. The registered verdict (cost lower) does not change.

S3 ran in full on 2026-11-07, as registered: 336 runs, 56 units (28 tasks × read-only and writer) × 3 seeds × 2 arms, at concurrency 4 with `--min-free-gib 4`. It billed **$54.60**. Every run resolved to `claude-sonnet-5-5`, so none was excluded. None errored, timed out or failed its launch check. BASE listed 11 tools (read-only) or 14 (writer), and NEW listed 8 or 11. Every run's `init` named 51 skills, NEW's too. Summary: `scripts/agent-bench/results/s3-S3.json`. Per run: `results/runs/s3-S3.csv`. Raw runs: `~/Library/Caches/pandacode-bench/s3/runs/S3`.

| Metric (per run, BASE → NEW) | BASE | NEW | Change, exp(mean d) − 1 | 95% CI | p | Read |
|---|---:|---:|---:|---:|---:|---|
| **Billed cost** (primary) | $0.1811 | $0.1439 | **−26.6%** | −30.7% to −22.7% | < 0.001 | **lower** |
| First-step cache write (secondary) | 31,444 | 22,979 | −40.3% | −46.8% to −33.8% | < 0.001 (Holm) | lower |
| Steps (secondary) | 3.79 | 3.86 | +2.2% | −2.1% to +6.9% | 0.36 (Holm) | not shown to be higher |
| Cache-read tokens | 125,097 | 101,548 | −24.2% | −29.6% to −18.2% | | descriptive |
| Output tokens | 1,644 | 1,578 | −4.2% | −7.0% to −1.2% | | descriptive |
| Wall time | 19.3 s | 18.5 s | −4.9% | −7.9% to −1.7% | | descriptive |

p ≤ 1/200,001 (about 5 × 10⁻⁶): none of the 200,000 sampled sign flips was as extreme as the observed one. The summary file stores this as 0; it is not 0. Means are over units, each the mean of its seeds.

| Cost by worker kind (descriptive) | Units | Change | 95% CI |
|---|---:|---:|---:|
| Read-only | 28 | −27.2% | −32.7% to −21.8% |
| Writer | 28 | −26.1% | −32.0% to −20.4% |

| Quality (descriptive) | Units | BASE | NEW | Difference | 95% CI |
|---|---:|---:|---:|---:|---:|
| Localization recall | 40 | 0.818 | 0.816 | −0.002 | −0.027 to +0.025 |
| Localization precision | 40 | 0.564 | 0.560 | −0.005 | −0.037 to +0.026 |
| Report rubric recall, registered rubrics | 16 | 0.921 | 0.902 | −0.019 | −0.103 to +0.048 |
| Report rubric recall, strict rubrics | 16 | 0.914 | 0.899 | −0.015 | −0.104 to +0.062 |

| Main-agent calls, 168 runs per arm (descriptive) | BASE | NEW |
|---|---:|---:|
| `pandacode_explore` | 349 | 335 |
| Bash | 150 | 152 |
| Runs with any Bash call | 66 | 73 |

- **Billed cost: lower** (registered verdict). The registered estimand is −26.6% (CI −30.7% to −22.7%), the geometric mean of the per-unit ratios. In money: $0.037 per worker run, a −20.5% ratio of means (corrected wording, S3-1; the first version paired −26.6% with $0.037, which mixed the two estimands). It is lower for read-only workers and writers alike.
- **First-step cache write: lower,** by 40%, about 8.5k tokens. That is the skill listing, the three agent-made tool specs and `REUSE`.
- **Steps: not shown to be higher** (+2.2%, CI −2.1% to +6.9%). Explore and Bash use barely moved.
- **The registered estimand came out larger than the expectation** (−10% to −20%). The ratio of means (−20.5%) is at the edge of it. The expectation divided the smoke's first-write gap by the smoke's mean bill ($0.28). S3's units average $0.18, and the geometric mean weights its cheap units more (see the table in S3-1). *Withdrawn (S3-1):* the first version explained the gap by cache reads of the listing on every later step. Cache reads did fall 24%, but at $0.10/M that is $0.0024 per run, 6% of the saving.
- **Quality:** every difference is within 0.02, and every CI spans 0. No quality gate was registered. The report CIs are wide (16 units).

**Limits.** One user's skills library (35 entries), loaded with `--add-dir`, without plugin skills. A user with fewer skills saves less, and one with more saves more. Sonnet workers on read-only tasks run as read-only and as writer workers: real writer tasks run longer, so the fixed first-step saving is a smaller share of their bill. Further limits are in S3-1, point 5. `bin-f`'s agent-made tool descriptions are the ones before round 18. Workers' own instructions beyond `LOOK` and `REUSE` are not sent in either arm.

**Spend this round:** S3 $54.60, the smoke $2.25 billed, and probes under $0.10: about **$56.95**. The S3 ledger shows $66.86 because it charged $5 caps for two smoke runs that were stopped while waiting for disk, before any model call.

<!-- deviation:S3-1 -->
### S3 corrections (round 19, deviation S3-1)

**POST-HOC: written on 2026-11-07, after S3's results were known (council round 16).** Nothing here changes S3's registered verdicts: billed cost is lower, first-step cache write is lower, and steps are not shown to be higher. The numbers below come from S3's own runs (`results/runs/s3-S3.csv`). `absoluteSaving` in `s3.mjs` adds the ratio of means and the absolute saving to the summary. It was added after S3, so these two are descriptive for S3. They are registered for S3b.

1. **Estimands.** The write-up led with −26.6% and paired it with $0.037. These are two different estimands:

   | Billed cost per run, 56 units | Value | 95% CI |
   |---|---:|---:|
   | Absolute saving, mean BASE − mean NEW | $0.0372 | $0.0343 to $0.0399 |
   | Ratio of means, mean NEW / mean BASE − 1 ($0.1811 → $0.1439) | −20.5% | −23.4% to −18.0% |
   | Geometric mean of per-unit ratios (the registered estimand) | −26.6% | −30.7% to −22.7% |

   Where the $0.0372 goes, at the prices `metrics.mjs` fits ($4/M write, $0.10/M read, $10/M output): first-step cache write 8,465 tokens, $0.0339 (91%); cache reads 23.5k tokens, $0.0024 (6%); output 67 tokens, $0.0007 (2%); later writes 73 tokens, $0.0003 (1%).

   Withdrawn: the claim that the listing and specs are "read again on every later step" explains the size of the saving, and the claim that "the per-step read saving grows with steps". Reads are 6% of the saving, so neither claim is supported.

2. **Heterogeneity.** The saving is roughly a fixed amount per worker run, so its share is smaller where the bill is larger:

   | Units by BASE cost | Units | BASE mean | Saving per run | Geometric mean change | Ratio of means |
   |---|---:|---:|---:|---:|---:|
   | under $0.12 | 16 | $0.095 | $0.040 | −44.6% | −42.5% |
   | $0.12 to $0.25 | 32 | $0.187 | $0.035 | −19.4% | −18.7% |
   | over $0.25 | 8 | $0.332 | $0.040 | −12.0% | −12.2% |
   | PandaCode `loc-agent-env`, read-only | 1 | $0.390 | $0.071 | −18.1% | |
   | PandaCode `loc-agent-env`, writer | 1 | $0.361 | $0.044 | −12.1% | |

   The bands were picked after the results were seen. On repos with a large project memory (PandaCode's `AGENTS.md` is 28.7k tokens) every worker writes the memory first, so the same saving is a smaller share of the bill.

3. **BASE fidelity.** BASE gives workers `pandacode_tool_list`, `_save` and `_run` with their full descriptions, plus `REUSE`. This is the launch from before round 18 as the bench built it, from `bin-f` and `lib.rs`. No git history shows what the app sent to workers then, so this cannot be checked. The current app, for an ordinary task whose store is empty, offers only `pandacode_tool_save` with a short description (`FIRST_SAVE_DESCRIPTION` in `custom_tools/host.rs`), and the save instruction in place of `REUSE`. So BASE may be a larger launch than any real one had.

4. **Attribution.** S3 does not measure how the saving splits between the skill listing, the agent-made tool specs and `REUSE`. MCP tools are deferred behind ToolSearch, so their specs are not in the first request, only their names. `REUSE` sits in the system prompt, which is a cached read. So most of the saving is likely the skill listing. Batch S3b (below) measures the launch with only the bundled skills listed.

5. **Limits.**
   - The runs use `--setting-sources project`: no user rules, hooks, plugins or MCP servers. A real install sends more of its own tokens each run, so the real-world percentages would be smaller. The dollar saving should be about the same, if the listing is the same.
   - The p-value is ≤ 1/200,001, not 0 (above).
   - The power simulation (registered with S3) draws every unit and seed independently. A task's read-only and writer units share the repo and the prompt and are correlated, so the effective number of units is smaller than 56 and the simulated power is too high. S3's result is far past its threshold, so this does not change it.
<!-- /deviation:S3-1 -->

## Batch S3b: the same launch for users without a skills library

<!-- prereg:S3b -->
### Pre-registration: batch S3b

Written on 2026-11-07, after S3's results and one smoke (`loc-agent-env` and `rep-explain-queue`, both worker kinds, both arms, seed 99, 8 runs, $1.99 billed; runs in `~/Library/Caches/pandacode-bench/s3b/runs/smoke-S3b`, never analysed with S3b), and before any S3b run.

**Question.** For a user with no skills library of their own, does round 18's team worker launch (NEW) bill less than the launch before it (BASE), for read-only and writer workers?

**Design.** S3 as registered (harness, model pin, `bin-f`, arms, `LOOK`/`REUSE`, message, tasks, units, grading, exclusions, launch checks), with one change: **no `--add-dir`**, so no user skills are copied in. With `--setting-sources project` only Claude Code's bundled skills are listed. In the smoke every run's `init` named 17 skills, NEW's too. `s3.mjs --bundled-only` does this. Its launch check (`launchProblem` with `bundledOnly`) stops the batch if any run lists one of the names in `~/.claude/skills`, if BASE lists no skill at all, or if an arm's tools are not its arm's (as in S3). `batch.json` pins `skills: "none"`.

**Seeds.** Chosen from the power table below. Two seeds are the fewest that reach 80% at −8%. We run **3 (1, 2, 3)**: power is the same within simulation noise, the design then matches S3, and the secondaries and quality get more runs. That is 336 runs. Job and arm order come from the batch seed in `batch.json`.

**Primary.** Billed cost per run, BASE → NEW, on the log-ratio scale exactly as in S3: per unit d = log(mean NEW / mean BASE) over seeds, a two-sided Wilcoxon signed-rank test on d (exact to 17 units, else 200,000 sampled sign flips), a 95% bootstrap CI of mean d, reported as exp(mean d) − 1. Cost is read as lower only if p < 0.05 and the CI's upper end is below 0.

**Also reported for the primary, with no test:** the ratio of means (mean NEW / mean BASE − 1 over unit means) and the absolute saving per run (mean BASE − mean NEW in dollars), each with a 95% bootstrap CI over units (`absoluteSaving` in `s3.mjs`). The p-value is reported as ≤ 1/200,001 when no sampled flip is as extreme.

**Secondary,** Holm-adjusted together, as in S3: first-step cache-write tokens and steps.

**Descriptive:** as in S3, plus the saving split by component (first write, later writes, cache reads, output) at `metrics.mjs`'s fitted prices, and the comparison with S3 (the part of S3's saving that depends on a skills library).

**Quality,** descriptive with no gate, as in S3.

**Power.** `s3.mjs --power --power-from <S3 runs>` simulates S3b's design from S3's runs. Each unit draws its seeds' costs with replacement from one S3 unit's six runs. NEW's runs are divided by that unit's own NEW/BASE ratio, so both arms sit at BASE's level. NEW's draws are then multiplied by (1 + effect), and a normal per-unit spread τ is added on the log scale. S3's observed sd of d is 0.211. Resampling alone gives 0.049, so τ = 0.205. Most of S3's spread is real heterogeneity of the effect (S3-1, point 2), so seeds barely move power. The rule is the primary's, with the normal approximation of the Wilcoxon test. 400 simulated batches per cell.

| P(cost reads lower) | τ = 0.205 | τ = 0.411 |
|---|---:|---:|
| No effect, 1 / 2 / 3 seeds | 0.04 / 0.03 / 0.03 | 0.03 / 0.03 / 0.03 |
| −5%, 1 / 2 / 3 seeds | 0.38 / 0.38 / 0.42 | 0.13 / 0.16 / 0.13 |
| −8%, 1 / 2 / 3 seeds | 0.77 / 0.81 / 0.81 | 0.31 / 0.28 / 0.30 |

Caveats, written down now:
- The simulation assumes independent units. A task's two units are correlated, so power is overstated (S3-1, point 5).
- S3's spread came with a −27% effect, and a smaller effect probably varies less across units. If so, τ is too large and power is understated. If heterogeneity scaled with the effect, the −5% power would be close to resampling alone (sd 0.049), which reads lower almost always.

**Expectation, written down before running:** cost −3% to −8% (geometric), about $0.009–0.010 per run. In the smoke BASE wrote 2.37k–2.38k more first-step tokens than NEW in all four pairs: about $0.0095 at $4/M. That is about −5% of S3's mean BASE bill, more on cheap units. Steps: no change.

**Cost.** About $55 at S3's $0.16 a run. The user approved unlimited spend.

**Commands.**

```sh
S3B="node scripts/agent-bench/s3.mjs --out $HOME/Library/Caches/pandacode-bench/s3b --batch S3b --bundled-only"
node scripts/agent-bench/s3.mjs --power --power-from ~/Library/Caches/pandacode-bench/s3/runs/S3   # the table above
node scripts/agent-bench/s3.mjs --register --batch S3b    # appends this section's sha256 to results/preregistrations.jsonl
$S3B --concurrency 4 --min-free-gib 4
$S3B --analyze --summary scripts/agent-bench/results/s3-S3b.json --csv scripts/agent-bench/results/runs/s3-S3b.csv
$S3B --analyze --strict-rubrics scripts/agent-bench/results/s1v3-strict-rubrics.json --summary scripts/agent-bench/results/s3-S3b-strict.json
```
<!-- /prereg:S3b -->

### S3b status: void, rerun needed (recorded 2026-11-07 by the architect)

S3b started as registered, but the Claude subscription's weekly usage limit was reached at 14:05:58 local time, after 32 of 336 runs. Every later run returned at once with no model call ($0.000, first-step write 0), so 304 of 336 runs are not measurements. **S3b has no result and must not be analyzed as it stands.** The 32 earlier runs are too few and unbalanced across arms to read. Rerun the registered S3b from scratch after the limit resets (Nov 8, 8 pm America/New_York), under a deviation that records this void attempt.

## Probe: project memory in the cached system prompt (round 19, descriptive)

**A probe, not a batch:** 3 runs per arm, nothing registered, no app change. The architect decides.

**Question.** Can the pinned harness (Claude Code 2.1.317) turn off its built-in `AGENTS.md` loader for one run, so the project memory can be passed with `--append-system-prompt` instead? And is the memory then a cache read for the second and later workers?

**Switch.** The loader is a built-in plugin, `cc-plugin-agents-md` (`agents-md@builtin`). It has an `instructionFiles` option (`claude-md`, `claude-md-or-agents-md` (the default), `claude-md-and-agents-md`, `managed-only`). This turns it off for one run, even with `--setting-sources project`:

```sh
--settings '{"enabledPlugins":{"agents-md@builtin":false}}'
```

`cc-plugin-agents-md@builtin` works too. With it off, `init.plugins` no longer lists the plugin, and the first write of an `ok` run in a folder that holds only PandaCode's `AGENTS.md` falls from 35.2k to 4.7k tokens. `--bare` would also drop memory discovery, but it never reads the OAuth login, so it does not work with a subscription.

**Setup.** A fresh git folder in `/tmp` that holds only this checkout's `AGENTS.md` (the PandaCode project memory). Each run is `claude -p "Worker task <unique id>: reply with the single word ok."` with `--model sonnet` (`claude-sonnet-5-5`), `--setting-sources project` and NEW's read-only worker `--disallowedTools`. The three runs of each arm run one after another, each with a different task line, as a team's workers would. No explore server, no `LOOK`. First-step usage:

| Run | A: default (plugin loads `AGENTS.md`) | B: plugin off, `--append-system-prompt-file AGENTS.md` | C: plugin off, no memory |
|---|---:|---:|---:|
| 1st worker | write 35,829, read 0, $0.1434 | write 35,713, read 0, $0.1429 | write 1,080, read 6,047, $0.0050 |
| 2nd worker | write 29,782, read 6,047, $0.1198 | write 1,079, read 34,634, $0.0078 | write 1,080, read 6,047, $0.0050 |
| 3rd worker | write 29,782, read 6,047, $0.1198 | write 1,079, read 34,634, $0.0078 | write 1,080, read 6,047, $0.0050 |

- **A (today):** every worker writes the memory again: 29.8k tokens, about $0.12 each.
- **B:** the first worker pays the same as A. Every later worker reads the memory from cache: it writes 1.1k tokens and pays $0.008 for this step. That is about $0.112 less per later worker on PandaCode. The system prompt's cache breakpoint lasts 1 hour, so workers started within an hour of each other share it, if their system prompts are the same byte for byte.
- C shows what is left without any memory: 1.1k written per worker.

**Not measured.** Whether the model follows the memory as well from the system prompt as from the first user message. Also not measured: everything the plugin and Claude Code's discovery do that one appended file does not, such as nested and ancestor `AGENTS.md`/`CLAUDE.md` files, `.claude/rules`, imports, `CLAUDE.local.md` and the user's own memory. With `--setting-sources project` the user's files were not loaded in either arm. A real launch would have to rebuild that discovery or accept losing it (the risk noted in [worker-tokens.md](worker-tokens.md#levers-tried-and-dropped)). That lever was dropped because, without the plugin switch, the memory was sent twice. The switch above removes that reason.

**Spend:** $0.72 for the 12 probe runs (3 setup runs and 9 measured runs).
