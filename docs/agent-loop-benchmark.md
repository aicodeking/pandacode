# Agent loop benchmark: `pandacode_explore`

Does giving an agent `pandacode_explore` shorten its loop without making its results worse? The harness is `scripts/agent-bench/`.

- [Round 2: pre-registration](#round-2-pre-registration) is fixed before any new data is collected.
- [Round 2 results](agent-loop-benchmark-history.md#round-2-results) follow it, with deviations listed first.
- [Round 3 (batch C, run as batch D)](agent-loop-benchmark-history.md#round-3-batch-c-pre-registration) re-runs the comparison on the new engine with an optimized server. Batch D replaces C, which never ran; [its results](agent-loop-benchmark-history.md#batch-d-results-round-4-engine-optimized-server) follow the pre-registration.
- [Round 1 (v1), corrected](agent-loop-benchmark-history.md#round-1-v1-corrected) replaces the earlier report of this benchmark.
- [Batch E: pre-registration](#batch-e-pre-registration) was written before any E run; [its results](#batch-e-results-shipped-engine) follow its deviations, with the E2 extension and pooled E+E2 as secondary.
- [Batch F: pre-registration](#batch-f-pre-registration) measures the engine with its stop rule, edit rule, smaller replies and glob fixes, with a new edit task set. F never ran; [Batch Fv2](#batch-fv2-pre-registration) superseded it, and [its results](#batch-fv2-results) follow its deviations.
- [Batch R1 (pilot)](#batch-r1-pilot-pre-registration) is a descriptive pilot of agent-made tools; [its results](#batch-r1-results-descriptive) follow its deviation.
- Deviations from now on sit between `<!-- deviation:<batch>-<n> -->` markers, and each is appended to `scripts/agent-bench/results/preregistrations.jsonl` with its sha256 and time as soon as it is written (`run.mjs --register <batch>-<n> --marker deviation:<batch>-<n>`).
- **How much the timing evidence is worth.** Registrations are local: `preregistrations.jsonl` is hash-chained (each entry holds the sha256 of the one before it) and timestamped by this machine's clock only. Nothing anchors them in git or any outside service, so the chain shows that no entry was edited after the next one was written, not when an entry was written.
- Sections marked **POST-HOC** were written after the results they discuss were known (for example [Fv2 post-hoc](#post-hoc-gate-calibration-edit-failures-and-relabelling), deviation Fv2-2). They never change a registered verdict.

> **What is measured**
>
> - **Engine.** The newest measured engine is batch Fv2's snapshot `bin-f` (binary `34c3de07`, sources `e92e0a7e`, deviation Fv2-1), built on 2026-11-07. Engine changes after that are unmeasured.
>   - *Replay check, 2026-11-11 (no model calls):* `replay.mjs --runs v2/runs/Fv2` replayed Fv2's 164 recorded AFTER explore calls through `bin-f` and then through a debug test binary of the post-Fv2 tree. Reply bytes went from 605,623 to 605,784 (+161 B, +0.03%), with 0 errors and no gold lost (earned gold 180/180 in both). Call times are not comparable, because the binary profiles differ. The `bin-f` replay is saved outside the repo at `~/Library/Caches/pandacode-bench/v2/r23-Fv2-binf.json`.
>   - *Replay check, 2026-11-23 (no model calls):* replayed the same 164 recorded AFTER explore calls from `v2/runs/Fv2` through a debug test binary of commit `456f5883` (`src-tauri/src/explore.rs` and `src-tauri/src/explore/`, unchanged after that commit) against the saved `bin-f` replay (`~/Library/Caches/pandacode-bench/v2/r23-Fv2-binf.json`, outside the repo). Reply bytes went from 605,623 to 605,568 (-55 B, -0.01%), with 0 errors, no gold lost (`earned` 180/180 in both), and 10/23 empty-glob searches answered outside the glob. Call times are not comparable, because the binary profiles differ.
> - **Agent.** Sonnet (`claude-sonnet-5-5`) in Claude Code 2.1.317 (`claude -p`), and nothing else. Other models and harnesses that get the tool (GLM and MiMo through Claude Code, Codex, OpenCode, Pi, Grok and more) are not tested, so explore is on by default only in Claude Code; the rest opt in (`explore::on_by_default`).
> - **Baseline.** BEFORE is Claude Code with no extra tool. This harness has no Grep or Glob tools (they aren't in `init.tools`), so BEFORE searches with Bash (`rg`, `grep`, `find`) and Read. A harness with good built-in search tools could gain less.
> - **Tasks.** 20 localization tasks (13 PandaCode, 6 Outline, 1 VS Code), 6 PandaCode edit tasks and, from Fv2, 14 edit tasks v2 (8 Hono, 6 PandaCode). The engine was tuned between batches on these same 20 tasks, so their results can flatter it. 8 held-out tasks (`tasks-heldout.json`, 4 from Hono) exist from batch E onward and are reported apart.
> - **Seeds** are replicate labels: the harness takes no seed, so seed 5 and seed 6 are just two runs.
> - **Means** in the main tables are means of per-task means. Tables marked "means over runs" weight every run equally.
> - **Data.** Per-run numbers for every batch are in `scripts/agent-bench/results/runs/*.csv`, and `analyze.mjs --runs <csv>` reruns the analysis from them. The raw transcripts are kept outside the repo, in `~/Library/Caches/pandacode-bench/`.

## Bottom line (latest: batch Fv2)

Batch Fv2 measured `bin-f` (the engine and `LOOK` text it was built from) on seeds 11 and 12 in Claude Code 2.1.317 with Sonnet, with no budget caps. Everything registered ran: 240 runs, none stopped or excluded. It is judged on Fv2 alone, as registered. Batch E's bottom line follows below.

- **Steps: lower.** On the 20 tuned localization tasks AFTER took **12% fewer steps** (4.92 → 4.20, CI -19% to -5%, Wilcoxon p = 0.003, Holm p = 0.005; 12 tasks better, 1 worse).
- **Cost: not shown to be lower.** -3% ($0.173 → $0.163, CI -8% to +1%, Holm p = 0.017). The p clears 0.05 but the CI reaches zero, so by the registered rule it is not shown.
- **Wall time: lower,** -14% (CI -21% to -8%, max-T p = 0.004).
- **Gates.** Tuned recall passes (0.794 → 0.797, CI -0.043 to +0.057). **Tuned precision fails: not shown non-inferior** (0.574 → 0.562, CI -0.066 to +0.040). Edit pass passes (9/12 → 12/12, CI +0.083 to +0.417). Edit tasks v2 pass passes (27/28 → 27/28, CI 0 to 0).
- **Edit steps: not shown to be no longer.** The registered non-superiority test at +5% fails: mean change +2% (CI -10% to +14%, one-sided p = 0.32) over the 6 + 14 edit tasks. E's +20% did not recur (6 old edits +4%, CI -11% to +20%; edit2 +1%, CI -15% to +17%), but the test can't show edits are no longer.
- **AFTER-E (E's `LOOK` on the same engine; descriptive).** The new text against E's: edit steps -5% (CI -16% to +5%) on the 6 edits and +2% (CI -5% to +9%) on edit2; passes 9/12 → 12/12 and 27/28 → 27/28. Nothing separates the two texts.
- **Held-out (descriptive):** steps -21% (CI -33% to -10%, Wilcoxon p = 0.016, 7 better, 0 worse); recall and precision both clear the -0.05 margin (precision 0.703 → 0.702, CI -0.041 to +0.034), unlike E.
- **Long context** (8 of 8 valid, 1 seed): steps -23%, cost -22%; every p ≥ 0.125, so none is shown.
- **Reading the failed gates (POST-HOC).** A simulation from BEFORE's own runs in E, E2 and Fv2 (deviation Fv2-2) shows that with Fv2's design tuned precision passes only 70% of batches with no effect at all, and the edit-steps test 11%. So the precision and edit-steps failures are what a tool with no effect would often produce: they are "not shown", never evidence of harm. Both gates also pass 0% of batches with a true loss of 0.10 (10% more steps), so their passes elsewhere do rule such a loss out. Details under [the post-hoc section](#post-hoc-gate-calibration-edit-failures-and-relabelling).
- **Edit failures:** all 9 failed Fv2 edit runs are agent failures; none was a build or infrastructure failure (POST-HOC classification, Fv2-2).
- **R1 (agent-made tools pilot, descriptive):** in 12 runs no agent saved or ran a tool, so reuse was never tested; details under [Batch R1 results](#batch-r1-results-descriptive).

## Batch E bottom line

Batch E measured the shipped engine (`bin-e`) on seeds 7 and 8, with no budget caps. The primary and the gate are judged on E alone, as pre-registered. Batch D's bottom line is kept under [Batch D results](agent-loop-benchmark-history.md#batch-d-results-round-4-engine-optimized-server).

- **Speed: yes, on the tuned localization tasks.** AFTER took **10% fewer steps** (CI -20% to -2%, Wilcoxon p = 0.036, 10 of 20 tasks better, 3 worse). Wall time fell 16% (CI -22% to -10%, max-T p = 0.001) and API time 11%. The E2 extension (seeds 9, 10) gave the same -10%, but its CI reaches zero, so on its own it is "not shown to be lower"; pooled E+E2 is -11% (CI -18% to -3%, p = 0.013).
- **Held-out tasks** (never tuned on): steps -10%, **not shown to be lower** (CI -26% to +6%, 8 tasks).
- **Cost: within noise.** -2% (CI -6% to +3%, max-T p = 0.96). The CI is too wide to call it unchanged.
- **Quality: not shown non-inferior.** On E's tuned tasks, recall (0.802 → 0.827) and precision (0.545 → 0.558) pass. **Edit pass fails**: 11/12 → 10/12 (CI -0.25 to 0). E2 went the other way (10/12 → 11/12), and pooled is 21/24 in both arms, which still can't clear the margin with 6 tasks.
- **Precision fails outside E's tuned gate.**
  - **E2's tuned precision fails** (0.543 → 0.535, CI -0.055 to +0.040: the lower bound is 0.005 past the margin), so D's precision loss did not go away; E's pass was not replicated. Pooled E+E2 tuned precision passes (CI -0.036 to +0.041).
  - **Held-out precision fails** in E (0.764 → 0.672, CI -0.222 to +0.008), in E2 (0.765 → 0.718, CI -0.133 to +0.033) and pooled (0.764 → 0.695, CI -0.166 to +0.002). These gates are descriptive, but they point the same way: on tasks it was never tuned on, AFTER names extra files.
- **Edits: steps and output not shown to be higher.** E: steps 6.08 → 7.08 (+20%, CI +5% to +39%), output tokens +28% (CI +11% to +45%), cost +7%. Pooled E+E2: steps +18% (CI -3% to +40%), output tokens +20% (CI +5% to +32%). No edit p-value reaches 0.05 (E steps: 2 tasks tied, leaving 4, so the smallest possible p is 0.125), so by the registered rule none is read as a change. Every point estimate is an increase, which is why Fv2 tested edit steps directly. (Wording corrected post-hoc, deviation Fv2-2: it read "more steps and more output", which the rule does not allow for results that are not significant.)
- **Long context:** 8 of 8 ran; steps 4.0 → 3.5 and duration -31%, all CIs span zero (1 seed).

## Round 2: pre-registration

Written on 2026-11-05, before any round 2 run. Results will be added below it, and this section stays as written. Any later change to it is listed under [Deviations](#deviations).

### Question and arms

| Arm | Adds |
|---|---|
| BEFORE | Nothing. |
| INSTRUCTION | A batching instruction in `--append-system-prompt`, with no tool. |
| AFTER | The `explore_mcp_serve` MCP config, plus the explore clause of `LOOK` from `lib.rs`. |

`WAIT_AND_CHECK` is not part of any arm, because it isn't under test. AFTER against BEFORE is the main comparison. AFTER against INSTRUCTION separates the tool's effect from the instruction's.

*Note added on 2026-11-06:* `WAIT_AND_CHECK` has since been removed from the app. No batch ever measured it, so it was dropped, and the app no longer ships it.

Arm order is re-randomized in each batch from a seed saved in the batch's `batch.json`. The arms share the model (`sonnet`), harness version, prompts and isolation flags. The runner refuses to start unless the harness is `2.1.317`, and stops a batch if a run reports any other version or a model other than `claude-sonnet-5-5`.

### Primary measure and gates

- **Primary:** `steps` on localization, meaning distinct model requests (message ids) in the main thread. AFTER is lower if Wilcoxon p < 0.05 and the 95% CI of the mean per-task change excludes zero.
- **Secondary and labelled:** `num_turns`, which also counts parallel tool messages, so it penalises AFTER.
- **Other metrics:** turns, wall, duration, API time, API time per step, non-API time, cost, cost beyond the first write, cost at 150k context, cache reads, cache writes and output tokens. They are one max-T family (Westfall-Young, task signs flipped together). A metric reads "lower" or "higher" only if corrected p < 0.05 and its CI excludes zero; anything else is "within noise". Cost to full recall is reported beside them, outside the family, since not every task reaches it in both arms.
- **Gate:** non-inferiority, with a margin of **-0.05**, on three measures: localization recall, localization precision and edit pass rate. The lower bound of the 95% CI of the mean per-task change must clear the margin. **The gate is applied to each batch separately and must pass in every batch.** A point estimate that isn't worse doesn't pass. With 6 edit tasks, one net task lost across its seeds is already past the margin.

If the gate fails, the result is "not shown non-inferior", whatever the speed numbers say.

### Tasks

Every task's gold set is what one source commit changed, excluding docs and lock files, and excluding files the commit created, which nobody could find at its parent. `--check-tasks` re-derives each set from git and fails on any difference. Each run happens at the source commit's parent, in a new one-commit repo.

**Localization: 20 tasks.** The v1 gold sets for schedule messages, project relink and remote journal could not be traced to a commit, so they were dropped. The other five v1 tasks were re-derived from their commits, and their gold changed to match.

| Task | Repo | Source | Gold files | Tags |
|---|---|---|---:|---|
| `loc-model-picker-errors` | PandaCode | `1d07f0a` | 4 | |
| `loc-opencode-efforts` | PandaCode | `19adbdd` | 2 | |
| `loc-cloud-credentials` | PandaCode | `88c7e6a` | 3 | secret-named |
| `loc-skill-brief` | PandaCode | `ca34af7` | 4 | glob-narrow |
| `loc-streaming-paint` | PandaCode | `52b2d48` | 8 | truncated-read |
| `loc-connect-keychain` | PandaCode | `2e457de` | 3 | |
| `loc-all-keychain` | PandaCode | `61d6c9d` | 6 | secret-named, glob-narrow |
| `loc-usage-keychain` | PandaCode | `c8b2130` | 2 | secret-named |
| `loc-antigravity-fallback` | PandaCode | `b7af92b` | 4 | glob-narrow |
| `loc-cline-mcp` | PandaCode | `2e9f46e` | 4 | truncated-read |
| `loc-branch-switch` | PandaCode | `a5d9543` | 7 | truncated-read, glob-narrow |
| `loc-agent-env` | PandaCode | `5676e87` | 7 | |
| `loc-team-stop` | PandaCode | `9980612` | 7 | glob-narrow |
| `out-csrf` | outline/outline | `3fafd2a` | 6 | auth |
| `out-auth-transports` | outline/outline | `41ba5c9` | 3 | auth |
| `out-cimd` | outline/outline | `e5b1ade` | 5 | auth, dot-config |
| `out-husky` | outline/outline | `30db1d7` | 2 | dot-config |
| `out-lint-sanitize` | outline/outline | `33296fb` | 2 | dot-config |
| `out-ci-disks` | outline/outline | `8ca53c0` | 2 | dot-config |
| `vsc-search-leak` | microsoft/vscode | `0ffea05` | 2 | big-repo (20,882 files at the parent, over the 4,000-file index threshold) |

- **What the tags test:** `secret-named` gold includes files such as `remote/secrets.rs`, `secret_store.rs`, `cloud_agents/credentials.rs` or `usage_keychain.rs`. `dot-config` gold includes files such as `.husky/pre-commit`, `.oxlintrc.json` and `.github/workflows/ci.yml`. `glob-narrow` gold spreads across directories that a narrow glob would miss. `truncated-read` gold includes files over 170 KB.
- **Ceiling:** several tasks have 4 to 8 gold files, so recall should sit under 1.0. A task's BEFORE recall of 1.0 marks it as at the ceiling, and the under-ceiling subset is reported separately. That subset is chosen from the results, so it is descriptive.
- **Public repos:** `.claude`, `.mcp.json` and `CLAUDE.md` are removed from their copies, so those repos' agent settings don't apply. `AGENTS.md` stays, as in real use.

**Edits: 6 tasks.** Each must pass a mutation check before any model time: the commit's tests must fail at the parent, must fail on an assertion with only the required symbols stubbed in, and must pass with the real fix. The three tasks that fail on an assertion at the parent need no stub, and their prompts name no new symbol. The other three must name the symbols their tests read (`PROVIDERS`, `HARNESSES`, `LOCK`, `ASSETS`, `supportedPlatforms`).

| Task | Commit | Parent + tests | With stub | With fix | Wider suite |
|---|---|---|---|---|---|
| `edit-appimage-x11` | `02f8dfe` | assertion | not needed | pass | release and npx tests |
| `edit-sidebar-sections` | `a592914` | assertion | not needed | pass | `tests/sidebar-*.test.mjs` |
| `edit-projects-added-order` | `f84bb7a` | assertion | not needed | pass | `tests/sidebar-*.test.mjs` |
| `edit-npx-platforms` | `91bff36` | build | assertion | pass | release and npx tests |
| `edit-recipe-harnesses` | `b26b182` | build | assertion | pass | `cargo test --lib providers::` |
| `edit-connect-secrets` | `28f989d` | build | assertion | pass | `cargo test --lib remote::` |

A run passes when the commit's own tests pass and the wider suite has no failure beyond those it already had with the real fix. Changed-file counts are reported per arm. Rust runs build with `CARGO_INCREMENTAL=0` in every arm, to save disk.

Replaced from v1: `edit-simulator-screen` and `edit-startup-smoke-bundle`, whose tests cover only a new helper, so a run could pass without wiring the fix in.

### Long-context scenario

4 tasks (`loc-skill-brief`, `loc-cloud-credentials`, `loc-model-picker-errors`, `loc-connect-keychain`), 1 seed, BEFORE and AFTER. Each run sends a deterministic filler turn of about 150k tokens over stream-json, waits for its result, and then sends the task in the same process. Only the task's turn is measured. A run counts only if its first step read at least 120k tokens from cache; other runs are dropped and reported. This set is descriptive and isn't part of the gate, since 4 tasks cannot reach p < 0.05.

### Budget and order

The runner enforces **$60** across everything under its output directory, using an fsynced ledger on disk (`ledger.jsonl`). Each run is written to the ledger at its cap before it starts, and with its billed cost when it ends. A run starts only if the total plus its cap still fits. Otherwise the runner stops, writes the batch's `report.json` with what ran and what remains, and exits with code 3.

**Restarts.** Rerunning the same command resumes the batch with the same seed and skips finished runs. On startup the runner stops any process it recorded that is still the same process, by PID and start time, and never by pattern. A run with no ending in the ledger is charged its cap, because its real bill can't be known, and is rerun; **the interrupted attempt counts for neither arm**. Each batch pins its seed, tool snapshot, harness version and task list, and a resume with anything different is refused.

| Step | Runs | Estimate |
|---|---:|---:|
| Smoke test: 3 arms, 3 probes, filler calibration | 7 | $1.70 |
| Batch A: localization 20 × 3 arms × 2 seeds, edits 6 × 3 × 2 | 156 | $28.20 |
| Batch L: long context | 8 | $7.20 |
| Batch B: localization 20 × 2 arms × 2 seeds, edits 6 × 2 × 1 | 92 | $17.00 |
| **Total** | **263** | **$54.10** |

Estimates use v1's mean run cost ($0.19 localization, $0.15 edit, $0.90 long context). Run in this order, so if the budget stops the work, what is lost is the end of batch B. Pairs stay complete except for the runs in flight at the stop.

### Deviations

All were decided before the analysis, and none changes a gate, arm or metric definition.

1. **Harness.** The user's Claude Code updated itself to 2.1.318 before the run. The runner used a private clone of the pinned 2.1.317 binary, as pre-registered. Every run reported 2.1.317 and `claude-sonnet-5-5`.
2. **Filler size.** The smoke test read 204k tokens at the first step with 600,000 characters of filler, so the filler was set to 560,000 characters. Every long-context run then read 173k–194k tokens from cache at its first step.
3. **Rust edit runs.** The two Rust tasks build their parent commit with today's `Cargo.toml` and `Cargo.lock` from this checkout. With the commits' own manifests, each run rebuilt 80 crates, which this shared disk could not hold. Both tasks were mutation-checked again this way (build, assertion, pass). Each run's target is an APFS clone of this checkout's `src-tauri/target`, removed after grading.
4. **Order.** Batch A ran localization first, then the Node edit tasks, then the two Rust tasks (2 at a time), so that writes to disk came last. Arm order within each task and seed is still the batch's seeded shuffle.
5. **Disk floor (6 GiB).** Other tasks' builds pushed free space under the floor three times.
   - First stop: the 4 runs in flight were killed, charged at their caps ($4 in all) and rerun.
   - After that: the runner started nothing below the floor, waited without killing runs that weren't writing, and would still have killed Rust runs.
   - Final stop: batch B stopped at 2.9 GiB free with nothing in flight.
   - **Not run:** batch B's 12 edit runs, and 3 of its 80 localization runs (`loc-branch-switch` s4 BEFORE, `out-cimd` s4 BEFORE and AFTER).
   - **To resume once free space is back above 6 GiB.** The same seed is used, and finished runs are skipped. The Rust tasks write about 1.5 GiB each.

     ```sh
     node scripts/agent-bench/run.mjs --batch B --set loc --arm before,after --seeds 3,4
     node scripts/agent-bench/run.mjs --batch B --set edit --arm before,after --seeds 3 --tasks edit-appimage-x11,edit-sidebar-sections,edit-projects-added-order,edit-npx-platforms
     node scripts/agent-bench/run.mjs --batch B --set edit --arm before,after --seeds 3 --tasks edit-recipe-harnesses,edit-connect-secrets --concurrency 2
     node scripts/agent-bench/analyze.mjs --runs <out>/runs/A,<out>/runs/B --summary scripts/agent-bench/results/v2-AB-before-after.json
     ```
6. **Two measurement bugs fixed before the analysis, in every arm.** Both are re-derived from the transcripts, and tests were added.
   - The answer parser could pair an earlier code block's closing fence with the next opening one, so 6 valid answers scored zero.
   - `duration_api_ms` turned out to be cumulative over a process, like `total_cost_usd`, so it is now differenced across result segments.

## Batch E: pre-registration

<!-- prereg:E -->
Written on 2026-11-06, before any batch E run and before E's snapshot is built. This section stays as written; its sha256 is recorded in `scripts/agent-bench/results/preregistrations.jsonl`, and `check.test.mjs` fails if either changes. Later changes go under "Batch E deviations", below the closing marker.

**Status: not run.** E needs the user's go-ahead, because it takes the total budget above the $80 cap.

**Question.** Does the shipped engine still shorten the loop, and does it pass the gate? Batch D measured an older engine (sources `1f267ae6`).

**Engine.** A new optimized snapshot, `bin-e`, built by `--prepare --snapshot bin-e` from the tree that ships, with the `fast-release` profile. Its sources hash now also covers `providers/mcp_host.rs` (the MCP host and `explore_host`) and `lib.rs` (the host path), as well as `explore/`, `explore.rs` and `workspace/secret_paths.rs`. `batch.json` pins the binary, sources, harness, `tasks.json` and `tasks-heldout.json` hashes, and records the runner's hash (`run.mjs`, `lib.mjs`, `metrics.mjs`, `ledger.mjs`); every run records the runner hash it ran under.

**Design.** BEFORE and AFTER only. Model, harness (2.1.317), arms, isolation, prompts (including the answer format) and the 20 tuned localization tasks and 6 edit tasks are unchanged from batch D.

| Set | Runs |
|---|---:|
| Localization, tuned: 20 tasks × 2 arms × seeds 7 and 8 | 80 |
| Localization, held-out: 8 tasks × 2 arms × seeds 7 and 8 | 32 |
| Edits: 6 tasks × 2 arms × seeds 7 and 8 | 24 |
| Long context: 4 tasks × 2 arms × 1 seed | 8 |
| **Total** | **144** |

Commands, in order: `--prepare --snapshot bin-e`; `--smoke --snapshot bin-e --arm before,after --no-long`; `--batch E --snapshot bin-e --set loc,edit --arm before,after --seeds 7,8 --heldout`; `--batch E --snapshot bin-e --set long`. Disk rules as for batch D.

**Held-out tasks.** `scripts/agent-bench/tasks-heldout.json`, sha256 `400b1fc72a24437e099d8251a2731e2783085078e7f7ca648f76bdbbd70228ca`. They were chosen on 2026-11-06, before any E run, and have never been run or used for tuning. Their gold is what each source commit changed, under the same rules as `tasks.json`, and `--check-tasks` re-derives it from git (0 problems at registration).

| Task | Repo | Source | Gold files | Tags |
|---|---|---|---:|---|
| `ho-realm-escape` | honojs/hono (new) | `ed1d5f7` | 7 | auth, glob-narrow |
| `ho-lambda-v2-headers` | honojs/hono | `8b7f9e9` | 4 | duplicate-code |
| `ho-accept-q0` | honojs/hono | `f147de5` | 4 | glob-narrow |
| `ho-content-type-case` | honojs/hono | `b20d422` | 6 | |
| `loc-deepseek-efforts` | PandaCode | `cf05f25` | 3 | |
| `loc-trace-refold` | PandaCode | `e25a110` | 4 | truncated-read |
| `loc-saver-measured` | PandaCode | `0ff804b` | 5 | |
| `loc-docker-cloud` | PandaCode | `7523279` | 5 | new-provider (its new module is not gold; the prompt says so) |

**Primary metric and gates: as in rounds 2 and 3, judged on batch E alone, with no pooling.**
- **Primary:** steps on the 20 tuned localization tasks, AFTER against BEFORE. It reads "lower" only if Wilcoxon p < 0.05 and the 95% CI of the mean per-task change excludes zero.
- **Gate:** non-inferiority with a margin of -0.05 on localization recall, localization precision and edit pass rate (tuned tasks and edits). The lower bound of the 95% CI of the mean per-task change must clear the margin.
- **Other metrics:** one max-T family, as before. Cost is the named secondary, with no gate.
- **Held-out tasks** are reported in their own section: steps, recall and precision, with the same gate computed and labelled descriptive, since 8 tasks give wide CIs. They are never pooled with the tuned tasks.
- **Reporting.** Whatever the outcome, E is reported. A primary result that isn't significant is written as "not shown to be lower", and a gate that fails as "not shown non-inferior", whatever the point estimates say.

**Answer format (council B8).** The answer prompt asks for the files that would change, with no limit, and D's precision loss came from longer lists. A change to "list only the files that must change, at most 8" is pre-registered here **for batches after E**. E keeps D's prompt, so that E measures the engine alone. A batch that uses the new prompt must say so and can't be compared with earlier batches on precision.

**Cost estimate.** From batch D's billed means per run: localization $0.168, edits $0.160, long context $0.86 (the filler turn included).

| Part | Runs | Estimate |
|---|---:|---:|
| Smoke test (2 runs, 2 probes) | 4 | $1 |
| Localization, tuned and held-out | 112 | $19 |
| Edits | 24 | $4 |
| Long context | 8 | $7 |
| Allowance for killed runs charged at their caps (4 × $1) | – | $4 |
| **Total** | **148** | **about $35** |

The ledger already holds $78.16, so E needs `--total-budget-usd 120`: $78 spent, about $35 for E, and $7 of headroom, because the runner reserves each in-flight run's cap ($1, or $2 for long context) and would otherwise stop the last runs early, as it did in batch D.
<!-- /prereg:E -->

### Batch E deviations

1. **Engine notes, recorded before any E run.** Since the pre-registration was written, the engine changed in two ways. None changes a gate, arm, task or metric, because E measures whatever engine ships, and its snapshot hash records which one that is.
   - **I1 is in the shipped engine.** `outside_glob` now lists hits outside the glob only when nothing matched inside it. It still reports the counts.
   - **I2 was reverted.** `tests_for` is not capped at 2 candidates per path.
2. **Checkouts moved out of `~/Library`.** The shipped engine refuses project roots under `~/Library`, `~/.config`, `~/.local` and `~/AppData`. So every tree a run, the sanity check, the smoke probe or `replay.mjs` makes is now created under the system temporary folder (`WORK_ROOT` in `lib.mjs`, overridable with `PANDACODE_BENCH_WORK`). `assertExplorable` refuses to start if a tree would land under a refused folder. Recorded data stays in `~/Library/Caches/pandacode-bench`. Only the location of the checkout changes; its contents do not. After the move, the replay against `r6b.json` reported 0 errors and no gold lost.
3. **No budget caps (the user's decision, 2026-11-06), recorded before any E run.** The user approved E with "run the benchmarks… use claude code for the benchmarks and don't have caps.. just let it rip".
   - **Total budget:** effectively unlimited. Every E and E2 command passes `--total-budget-usd 100000`. The ledger code is unchanged, so spend is still counted the same way.
   - **Per-run cap:** raised from $1 to **$10** per run, and from $2 to **$20** for long context, so no run is cut short. A new runner flag, `--run-cap-usd 10`, scales the per-run caps (long context gets twice it); the default stays 1. This changes the runner hash, which E's `batch.json` records from its first run.
   - **Why:** batch D lost runs to the caps. The $80 total stopped 3 of its 8 long-context runs, and the runner reserves each run's cap while it is in flight, so a tight total also stops runs early.
   - **What it changes:** only truncation. A run stopped by its per-run cap ends early, which would bias steps (and cost) downward in whichever arm ran into it more. No batch D transcript shows a `max_budget` stop, so for D this was a risk, not an observed bias. Prompts, arms, tasks, gates and metrics are unchanged.
4. **Extension E2, declared before any E run.** After E finishes, seeds 9 and 10 run for the 20 tuned localization tasks, the 8 held-out tasks and the 6 edits, as `--batch E2 --snapshot bin-e --set loc,edit --arm before,after --seeds 9,10 --heldout` (same snapshot, prompts and caps).
   - E2 is analysed apart from E and labelled **"extension, more power"**.
   - Pooled E+E2 results are reported as **secondary**.
   - The primary measure and the gate stay on **E alone**, exactly as pre-registered.
5. **Long-context command, recorded after it ran.** The pre-registered `--batch E --snapshot bin-e --set long` was refused before starting anything (`batch E was started with another heldoutHash`), because E's `batch.json` pins the held-out file from the localization command. It was rerun with `--heldout` added. That flag only satisfies the pin: the long-context set is drawn from the tuned tasks either way, and nothing ran or was billed by the refused start.
6. **Harness.** The user's own `claude` is 2.1.319, but every run used the pinned 2.1.317 copy in the benchmark's `harness/` folder, as the runner requires. All 280 E and E2 runs report `init.version` 2.1.317 and `claude-sonnet-5-5`, and no run stopped on `max_budget`.

## Batch E results (shipped engine)

Sonnet (`claude-sonnet-5-5`) in Claude Code 2.1.317, 2026-11-06. Snapshot `bin-e`: `fast-release`, opt-level `s`, binary `08cbb128`, sources `2743b4a4` (21 files), built from the tree as it is now; the build folder was deleted afterwards. Caps as in deviation 3.

**Smoke test.** AFTER connected the server, listed `pandacode_explore` and called it 3 times directly with no ToolSearch; its probe quoted only the explore clause. BEFORE had no MCP tools and no explore clause. Both localization runs had recall 1.00.

**What ran.** Everything planned, with no stops and no killed runs.

| Batch | Runs | Billed |
|---|---:|---:|
| Smoke (2 runs, 2 probes) | 4 | $0.29 |
| E: tuned localization 80, held-out 32, edits 24 | 136 | $21.27 |
| E: long context | 8 | $6.79 |
| E2 (extension): tuned 80, held-out 32, edits 24 | 136 | $21.14 |
| **Total** | **284** | **$49.49** |

The ledger now holds $127.65 ($119.65 billed, $8 charged in earlier rounds for killed runs).

### Gates (batch E alone, as pre-registered; the lower bound must clear -0.05)

| Measure | Before | After | CI of change | Result |
|---|---:|---:|---:|---|
| Recall (tuned) | 0.802 | 0.827 | -0.025 to +0.082 | pass |
| Precision (tuned) | 0.545 | 0.558 | -0.031 to +0.056 | pass |
| Edit pass | 0.917 (11/12) | 0.833 (10/12) | -0.250 to 0.000 | **fail: not shown non-inferior** |

- **Edit pass.** `edit-sidebar-sections` s7 failed in both arms (`sectionOf`, the same two tests as in D). The one discordant pair is `edit-projects-added-order` s8: AFTER failed `projects sort by recent activity, order added, or name`. McNemar p = 1. With 6 tasks, one lost pass already puts the lower bound past the margin.
- **Precision passes,** unlike batch D, with the prompt unchanged.

### Before vs after, batch E

**Tuned localization** (80 runs, 20 tasks; means of per-task means):

| Metric | Before | After | Mean change | 95% CI | Wilcoxon p | max-T p | Read |
|---|---:|---:|---:|---:|---:|---:|---|
| **Steps** (primary) | 5.22 | 4.50 | -10% | -20% to -2% | 0.036 | – | **lower** |
| Wall s | 24.84 | 20.33 | -16% | -22% to -10% | <0.001 | 0.001 | lower |
| Duration s | 24.42 | 19.83 | -16% | -23% to -10% | <0.001 | 0.001 | lower |
| API s | 21.38 | 18.77 | -11% | -16% to -6% | 0.001 | 0.003 | lower |
| API s/step | 4.13 | 4.22 | +3% | -3% to +11% | 0.674 | 0.916 | within noise |
| Non-API s | 3.05 | 1.07 | -59% | -76% to -39% | <0.001 | <0.001 | lower |
| **Cost $** (named secondary) | 0.174 | 0.168 | -2% | -6% to +3% | 0.388 | 0.962 | within noise |
| Cache read tokens | 193,361 | 168,192 | -10% | -21% to +1% | 0.276 | 0.378 | within noise |
| Cache write tokens | 33,650 | 33,329 | +1% | -3% to +6% | 0.757 | 1.000 | within noise |
| Output tokens | 1,960 | 1,804 | -7% | -13% to -1% | 0.069 | 0.148 | within noise |
| Cache write tokens per step after the first (descriptive) | 2,067 | 2,435 | +22% | +9% to +35% | 0.017 | – | higher |

Steps were better on 10 tasks and worse on 3. The largest savings were `loc-team-stop` (7.5 → 3.0), `loc-opencode-efforts` (8.0 → 5.0) and `loc-all-keychain` (6.0 → 3.5); `loc-usage-keychain` and `loc-antigravity-fallback` took one step more.

**Held-out localization** (32 runs, 8 tasks; descriptive, never pooled with the tuned tasks):

| Metric | Before | After | Mean change | 95% CI | Wilcoxon p | Read |
|---|---:|---:|---:|---:|---:|---|
| Steps | 5.25 | 4.56 | -10% | -26% to +6% | 0.344 | not shown to be lower |
| Wall s | 22.22 | 20.06 | -8% | -16% to +1% | 0.078 | within noise |
| Cost $ | 0.114 | 0.112 | -1% | -13% to +12% | 0.844 | within noise |
| Recall | 0.885 | 0.901 | +0.016 | -0.047 to +0.094 | – | gate: pass |
| Precision | 0.764 | 0.672 | -0.091 | -0.222 to +0.008 | – | gate: **fail** |

Held-out precision fell most on `loc-deepseek-efforts` (1.00 → 0.50), `ho-content-type-case` (0.83 → 0.69) and `loc-docker-cloud` (0.46 → 0.33): AFTER again named extra related files. On the tasks it was never tuned on, the tool shows the same direction of step saving, but 8 tasks can't show it.

**Edits** (24 runs, 6 tasks):

| Metric | Before | After | Mean change | 95% CI | Wilcoxon p | max-T p | Better / worse | Read |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Steps | 6.08 | 7.08 | +20% | +5% to +39% | 0.125 | – | 0 / 4 | not shown to be higher |
| Output tokens | 2,157 | 2,709 | +28% | +11% to +45% | 0.063 | 0.219 | 1 / 5 | within noise |
| Cost $ | 0.161 | 0.172 | +7% | +0% to +15% | 0.156 | 0.500 | 1 / 5 | within noise |

On steps, 2 of the 6 tasks tied, leaving 4, so the smallest possible p was 0.125 and no result could reach 0.05. Duration rose 16%, within noise. Cache writes per step after the first fell 19% (descriptive). Files changed 1.33 → 1.17.

**Long context** (8 of 8 runs, 4 tasks × 1 seed; descriptive): steps 4.00 → 3.50, duration 25.7 → 16.4 s, recall `loc-cloud-credentials` 0.67 → 1.00, `loc-skill-brief` 0.75 → 0.50 (with 7 → 3 steps), `loc-model-picker-errors` 1.00 → 0.75, `loc-connect-keychain` 1.00 → 1.00. Cost after the filler turn $0.141 → $0.119; with the filler turn each run billed about $0.85. All CIs span zero; one seed per task supports no conclusion.

### E2: extension, more power (seeds 9 and 10; not the primary or the gate)

| | Before | After | Change | 95% CI | Wilcoxon p | Read |
|---|---:|---:|---:|---:|---:|---|
| Steps, tuned | 4.92 | 4.28 | -10% | -19% to +0% | 0.012 | not shown to be lower (the CI reaches zero) |
| Wall s, tuned | 22.43 | 19.32 | -11% | -18% to -4% | 0.001 | lower (max-T p 0.029) |
| Cost $, tuned | 0.171 | 0.165 | +2% | -5% to +12% | 0.784 | within noise |
| Recall, tuned | 0.784 | 0.806 | +0.022 | -0.029 to +0.074 | – | pass |
| Precision, tuned | 0.543 | 0.535 | -0.008 | -0.055 to +0.040 | – | fail (lower bound 0.005 past the margin) |
| Edit pass | 0.833 (10/12) | 0.917 (11/12) | +0.083 | 0.000 to +0.250 | – | pass |
| Steps, held-out | 5.31 | 4.88 | -8% | -18% to +4% | 0.313 | not shown to be lower |
| Recall, held-out | 0.885 | 0.901 | +0.016 | 0.000 to +0.047 | – | pass |
| Precision, held-out | 0.765 | 0.718 | -0.047 | -0.133 to +0.033 | – | fail |

E2's edit failures: `edit-projects-added-order` s9 in both arms (the same test), and `edit-connect-secrets` s10 BEFORE (a build error: its change didn't add the `LOCK` name the commit's test uses).

### Pooled E + E2 (secondary)

| | Before | After | Change | 95% CI | Wilcoxon p | max-T p | Read |
|---|---:|---:|---:|---:|---:|---:|---|
| Steps, tuned (160 runs) | 5.08 | 4.39 | -11% | -18% to -3% | 0.013 | – | lower |
| Wall s | 23.64 | 19.82 | -14% | -20% to -8% | <0.001 | 0.002 | lower |
| API s | 21.14 | 18.57 | -10% | -15% to -5% | 0.001 | 0.009 | lower |
| Cost $ | 0.172 | 0.167 | +0% | -5% to +7% | 0.260 | 1.000 | within noise |
| Cache read tokens | 190,376 | 161,096 | -10% | -20% to +1% | 0.063 | 0.301 | within noise |
| Output tokens | 1,945 | 1,796 | -5% | -12% to +2% | 0.068 | 0.502 | within noise |
| Recall, tuned | 0.793 | 0.817 | +0.024 | -0.019 to +0.073 | – | – | pass |
| Precision, tuned | 0.544 | 0.546 | +0.002 | -0.036 to +0.041 | – | – | pass |
| Edit pass (48 runs) | 0.875 | 0.875 | 0.000 | -0.125 to +0.125 | – | – | fail (not shown non-inferior) |
| Steps, held-out (64 runs) | 5.28 | 4.72 | -9% | -21% to +4% | 0.219 | – | not shown to be lower |
| Recall, held-out | 0.885 | 0.901 | +0.016 | 0.000 to +0.047 | – | – | pass |
| Precision, held-out | 0.764 | 0.695 | -0.069 | -0.166 to +0.002 | – | – | fail |
| Edit steps | 6.38 | 7.13 | +18% | -3% to +40% | 0.344 | – | within noise |
| Edit output tokens | 2,249 | 2,636 | +20% | +5% to +32% | 0.094 | 0.156 | within noise |

### What the tool did (batch E)

| | Value |
|---|---|
| Adoption | tuned localization 38/40, first tool every time (`out-husky` went straight to Read twice, as in D); held-out 16/16; edits 11/12; ToolSearch never |
| Calls | 141 on tuned localization (3.5 per run), 51 of them asking more than one kind |
| Schema errors | 2 (`limit: unknown argument`, in `loc-skill-brief` s7 and `loc-streaming-paint` s7); 0 in E2 |
| Replies | median 3,205 characters, largest 16,833; 79 of 141 reported trimmed hits |

### Spend

$49.49 billed for E, E-long, E2 and the smoke test, against the pre-registration's estimate of about $35 for E alone (E and its long context came to $28.35). Sanitized summaries are `scripts/agent-bench/results/v5-E.json`, `v5-E2.json` and `v5-E-E2-pooled.json`; per-run numbers are `results/runs/v5-E.csv` and `v5-E2.csv`.

## Batch F: pre-registration

<!-- prereg:F -->
Written on 2026-11-07, before any batch F run and before F's snapshot is built. This section stays as written. Its sha256, its time and the sha256 of `tasks.json`, `tasks-heldout.json` and `tasks-edit-v2.json` go in `scripts/agent-bench/results/preregistrations.jsonl` once the round 15 `LOOK` text and `tasks-edit-v2.json` are final. `check.test.mjs` fails if any of them changes after that. Later changes go under "Batch F deviations", below the closing marker, each between its own `deviation:F-<n>` markers and registered when written.

**Question.** Does the engine after round 15 (a stop rule and an edit rule in `LOOK`, smaller replies, glob fixes) shorten the loop without raising cost, and does it pass the gates? E2 failed tuned precision, held-out precision failed in E, E2 and pooled, and edits took 20% more steps in E. Round 15 was aimed at those findings.

**Engine.** A new optimized snapshot, `bin-f`, built by `--prepare --snapshot bin-f` with the `fast-release` profile from the tree as it ships after round 15. `meta.json` records the binary and sources hashes and the `LOOK` clause the AFTER arm gets. The clause is now extracted with every `{explore}` replaced, as the app does; E's extractor replaced only the first, but E's `LOOK` had only one. `batch.json` pins the binary, sources, harness, `tasks.json`, `tasks-heldout.json` and `tasks-edit-v2.json`, and every run records the runner hash it ran under.

Built before registration: `bin-f` binary sha256 `9761bdf956c6c4505cbf8c8f59639e485064094f19e1f4e28e146e152de9e855`, sources `58161dfc727d029236f9d726f6b075870c7416defad50a5e1d04169944082122`, `LOOK` sha256 `4e05e5f1dffa2dc6e6b70e001d7a4a0ec1f3eb803795ee35d80b2dc0d6e477db`. A 6-run smoke batch (`F-smoke`, seed 99: `loc-connect-keychain`, `edit-sidebar-sections`, `e2-ho-etag-commas`, both arms) ran on it before registration; every run passed or found all gold files. Its runs are never analysed with F.

**Design.** The same as E: BEFORE and AFTER only, with the same model (Sonnet, `claude-sonnet-5-5`), harness (2.1.317), isolation and prompts, including D's answer format. The "at most 8 files" prompt is not used, so precision stays comparable with D and E.

**No instruction-only arm.** `tasks.json`'s `instructionOnly` text still carries the old "Do not re-read what a tool already showed" clause, which the round 15 `LOOK` dropped. F does not run that arm, so its text is left as it is: changing `tasks.json` would also change a file S1v2 pins, and an instruction-only arm would add 112 runs to test a question (instructions without the tool) that D and E already answered. A later batch that wants the arm must first align its text with the shipped `LOOK`.

| Set | Runs |
|---|---:|
| Localization, tuned: 20 tasks × 2 arms × seeds 11 and 12 | 80 |
| Localization, held-out: 8 tasks × 2 arms × seeds 11 and 12 | 32 |
| Edits: 6 tasks × 2 arms × seeds 11 and 12 | 24 |
| Edit tasks v2: 14 tasks × 2 arms × seeds 11 and 12 | 56 |
| Long context: 4 tasks × 2 arms × 1 seed | 8 |
| **Total** | **200** |

**Edit tasks v2** (`scripts/agent-bench/tasks-edit-v2.json`, built by another worker for this batch) are a separately registered set. `run.mjs --edit-v2` loads them as the set `edit2`. They are never pooled with the 6 original edits, and they have their own gate. Only tasks whose `--sanity --edit-v2` verdict is `ok` run; the excluded ones and their reasons are reported. Before registration all 14 had verdict `ok` (each fails on an assertion at the parent and passes with the fix; no stubs). The file's sha256 is registered with this section, and `batch.json` pins it as `editV2Hash`.
- 8 tasks are in Hono (`repo: "hono"`): they run in a `git archive` of the Hono clone, prune its agent files as the held-out tasks do, install nothing, and check with `bun --config=/dev/null test <file>`. Bun's `(fail) <name>` lines are failed tests on an assertion.
- 1 is PandaCode JavaScript (Node release scripts) and 5 are PandaCode Rust, built like E's Rust edits.

**Primary, co-primary and gates: judged on batch F alone, with no pooling.**
- **Primary:** steps on the 20 tuned localization tasks, AFTER against BEFORE.
- **Co-primary:** billed cost on the same tasks.
  - Both use Wilcoxon on per-task means with Holm's adjustment across the two (`analyze.mjs --holm-cost`).
  - Each reads "lower" only if its Holm p < 0.05 and the 95% CI of the mean per-task change excludes zero. Otherwise it is "not shown to be lower" (or "not shown to be higher").
  - Cost leaves the max-T family. The other secondaries keep one max-T family, as before.
  - Holm costs power. Applied to E's data, it would have turned E's steps result (Wilcoxon p = 0.036) into Holm p = 0.072, "not shown to be lower". F accepts that.
- **Gates, as in E:** non-inferiority with a margin of −0.05 on tuned localization recall, tuned localization precision and edit pass rate (the 6 original edits). The lower bound of the 95% CI of the mean per-task change must clear the margin.
- **Edit tasks v2 gate:** non-inferiority of the edit pass rate on the `edit2` set, margin −0.05, reported as its own gate (`editV2Pass`). Steps, output tokens and cost on `edit2` are reported in their own section.
- **Held-out tasks** are reported in their own section, with the same gate, labelled descriptive. They are never pooled with the tuned tasks.
- **Edits** (both sets) report steps, output tokens and cost with their CIs, whether or not any p-value can reach 0.05. With 6 tasks, ties can make 0.05 unreachable; the report says how many tasks tied.
- **Reporting.** F is reported whatever the outcome. The bottom line names every failed gate, including the descriptive held-out ones.

**Seeds.** 11 and 12, never used before. Long context runs one seed, as in E.

**Commands, in order:**

```sh
R="node scripts/agent-bench/run.mjs"
$R --prepare --snapshot bin-f
$R --sanity --edit-v2                      # verdicts for the new edit tasks; the old ones are kept
$R --smoke --snapshot bin-f --arm before,after --no-long
$R --batch F-smoke --snapshot bin-f --set loc,edit,edit2 --arm before,after --seeds 99 --edit-v2 --tasks <1 loc>,<1 edit>,<1 Hono edit2>
$R --batch F --snapshot bin-f --set loc,edit --arm before,after --seeds 11,12 --heldout --edit-v2 --run-cap-usd 10 --total-budget-usd 100000
$R --batch F --snapshot bin-f --set long --heldout --edit-v2 --run-cap-usd 10 --total-budget-usd 100000
node scripts/agent-bench/analyze.mjs --runs ~/Library/Caches/pandacode-bench/v2/runs/F --holm-cost --summary scripts/agent-bench/results/v6-F.json
```

The long-context command passes `--heldout --edit-v2` only to satisfy the pins in `batch.json` (E's deviation 5). Caps are as in E's deviation 3, so no run is cut short.

**Cost estimate.** From batch E's billed means: localization $0.17 a run, edits $0.17, long context $0.86 including the filler turn. By `run.mjs --plan`:

| Part | Runs | Estimate |
|---|---:|---:|
| Smoke test (2 runs, 2 probes) | 4 | $1 |
| F smoke batch (3 tasks × 2 arms) | 6 | $1 |
| Localization (tuned and held-out) and edits | 136 | $23.12 |
| Long context | 8 | $6.88 |
| Edit tasks v2 | 56 | $9.52 |
| **Total** | **210** | **about $42** |
<!-- /prereg:F -->

### Batch F deviations

None. F never ran; Fv2 supersedes it.

## Batch Fv2: pre-registration

<!-- prereg:Fv2 -->
Written on 2026-11-07, before any Fv2 run. It supersedes F, which never ran: no F run exists, so nothing is dropped or re-analysed. This section stays as written. Its sha256, its time and the sha256 of `tasks.json`, `tasks-heldout.json` and `tasks-edit-v2.json` are in `scripts/agent-bench/results/preregistrations.jsonl` (entry `Fv2`, `supersedes: F`), and `check.test.mjs` fails if any of them changes. Later changes go under "Batch Fv2 deviations", each between its own `deviation:Fv2-<n>` markers and registered when written.

**Everything in F holds** (question, engine, design, primary and co-primary with Holm, gates, held-out and edit2 reporting, seeds 11 and 12, caps), except for what this section changes.

**What changed from F, and why (council round 13):**

1. **Harness.** Fv2 is Claude Code only (2.1.317, Sonnet `claude-sonnet-5-5`). No result transfers to another harness. The `LOOK` text is the one `look()` in `lib.rs` builds for Claude-family harnesses (`claude_code` true): `LOOK` with `{explore}` replaced, then `EDIT_CLAUDE`. Other harnesses get a different edit sentence, which Fv2 does not measure.
2. **A registered edit-steps test.** E showed edits taking 20% more steps with the tool. Fv2 tests that directly, on the 6 original edits and the 14 `edit2` tasks together (20 tasks):
   - Per task, the relative change in mean steps over seeds, AFTER against BEFORE.
   - Non-superiority with a margin of **+5%**: it passes only if the one-sided Wilcoxon signed-rank test on (change − 0.05), alternative "below", gives p < 0.05, **and** the upper end of the 95% bootstrap CI of the mean change is below +0.05 (`editStepsGate` in `analyze.mjs`).
   - It is one test at α = 0.05, outside the Holm pair and the max-T family. The 6 + 14 tasks are pooled only for this test. Their pass-rate gates stay separate, as in F.
   - Power, by simulation from E and E2's edit runs (per-run noise SD 0.17 of the task mean, BEFORE's per-task steps resampled, 2 seeds, 20 tasks, 400 batches): P(pass) is 1.00 at a true change of −15%, 0.95 at −10% and 0.59 at −5%, and 0.20 at no change (the +5% boundary passes at most 5% by construction). So the test can show that edits got no longer only if they in fact got shorter. A failure at a true change near zero is the likely outcome and is reported as "not shown".
3. **A third arm on edits, `AFTER-E`** (`run.mjs` arm `after-e`). It is AFTER (the same `bin-f` server and the same flags) with batch E's `LOOK` text instead of the new one. That text is read at `--prepare` from E's snapshot (`--look-e bin-e`, `bin-e/meta.json`, binary `08cbb128…`), and its sha256 is in `meta.json` (`afterE.lookSha256`) and pinned in `batch.json` (`afterELookSha256`).
   - E's text: "Use pandacode_explore for code search, symbol lookup, outlines and ranged reads, with all your questions in one call. Do not re-read with another tool what it already showed."
   - It runs on all 20 edit tasks (6 `edit` and 14 `edit2`), seeds 11 and 12: 40 more runs. It never runs localization or long context.
   - AFTER against AFTER-E isolates the new text (the stop rule and the edit clause) on the same engine. It is **descriptive**: steps, output tokens, cost and pass rate with their 95% CIs and Wilcoxon p, never a gate. BEFORE against AFTER-E is also reported, descriptive.
   - Arm order inside each (task, seed) group is shuffled from the batch seed with all three arms on edit tasks and two elsewhere.
4. **Runner.** `run.mjs` and `saver.mjs` now share one runner core in `lib.mjs` (recovery, batch pins, job order, pool, measured run). The pool's semantics are `run.mjs`'s. Every run records the runner hash.

**Engine.** `bin-f` is rebuilt for Fv2 by `--prepare --snapshot bin-f` after round 16, so it replaces F's snapshot.

Built before registration (round 16 tree, `fast-release`, opt-level s): `bin-f` binary sha256 `ecbbd0c1082b948523ab442fe9abbb51718a7131fc4c75f1b953a6c211525dad`, sources `6bf059d84b63d652114d931d2f927510b516d600a4ada341a7125ae05b3f638b`, AFTER `LOOK` sha256 `c134797c27f930c5f57684a4ae8f908bcc8e7b7d190a320236666e1449d782f2`, AFTER-E `LOOK` sha256 `c53240c6ecd20cf45dba7e19971aed88c51889031509d782bfc2844794f63be8`.

| Set | Runs |
|---|---:|
| Localization, tuned: 20 tasks × 2 arms × seeds 11 and 12 | 80 |
| Localization, held-out: 8 tasks × 2 arms × 2 seeds | 32 |
| Edits: 6 tasks × 3 arms × 2 seeds | 36 |
| Edit tasks v2: 14 tasks × 3 arms × 2 seeds | 84 |
| Long context: 4 tasks × 2 arms × 1 seed | 8 |
| **Total** | **240** |

**Commands, in order:**

```sh
R="node scripts/agent-bench/run.mjs"
$R --prepare --snapshot bin-f --look-e bin-e
$R --batch Fv2-smoke --snapshot bin-f --set edit --edit-v2 --arm before,after,after-e --seeds 99 --tasks edit-sidebar-sections
$R --batch Fv2 --snapshot bin-f --set loc,edit --arm before,after,after-e --seeds 11,12 --heldout --edit-v2 --run-cap-usd 10 --total-budget-usd 100000
$R --batch Fv2 --snapshot bin-f --set long --arm before,after,after-e --heldout --edit-v2 --run-cap-usd 10 --total-budget-usd 100000
A="node scripts/agent-bench/analyze.mjs --runs ~/Library/Caches/pandacode-bench/v2/runs/Fv2"
$A --holm-cost --summary scripts/agent-bench/results/v6-Fv2.json                      # primary, gates, edit-steps test
$A --arms after-e,after --set edit,edit2 --summary scripts/agent-bench/results/v6-Fv2-edit-clause.json   # descriptive
$A --arms before,after-e --set edit,edit2 --summary scripts/agent-bench/results/v6-Fv2-before-e.json     # descriptive
```

The long-context command passes `--arm before,after,after-e --heldout --edit-v2` only so the pins in `batch.json` match; `after-e` never runs on long context. Smoke runs are never analysed with Fv2.

**Cost estimate** (`run.mjs --plan`, E's billed means): localization and all edits $39.44, long context $6.88, smoke about $1: **about $47**.
<!-- /prereg:Fv2 -->

Current app (outside the frozen section): `look()` appends `EDIT_OTHER` for other harnesses and `EDIT_CLAUDE` for Claude-family harnesses (Claude, GLM, MiMo, any model), a Read-first sentence ([edit rule](agent-tools.md#instruction)). The earlier Edit-without-Read shortcut text and the macOS shell note are gone from the app.

Fv2's Sonnet edit advice was also Read-first: AFTER's pinned `LOOK` text (sha256 `c134797c…`, recomputed from `instructions.after` in the bench cache's `v2/bin-f/meta.json`) ends "for a file you will edit, read the lines you need with Read, not explore, and make each file's changes in as few edit calls as your editor allows." The current `EDIT_CLAUDE` ("Before editing a file, Read the lines you need with Read (explore reads don't count). Make each file's changes in as few edit calls as your editor allows.", 154 B) is a similar wording of the same advice, not byte-identical, and has no paid-batch measurement of its own. Likewise, the `pandacode_explore` tool `DESCRIPTION` changed after `bin-f` (tightening "results are capped and say what was skipped" to "capped results say what was skipped" and adding "Search lines drop their indentation; read keeps it."), and that wording has no paid-batch measurement of its own either. The recount of edits in [the history](agent-loop-benchmark-history.md#edits-without-a-prior-read-recorded-recount) is observational evidence only.

The bench runner's AFTER arm (`exploreClause` in `scripts/agent-bench/lib.mjs`; `pandaInstructions` in `scripts/agent-bench/gui.mjs`) appends `EDIT_CLAUDE` and no shell note, so an unpinned rebuild of its `LOOK` + `EDIT_CLAUDE` would equal what the app ships to every Claude-family run. G2's registered texts predate the current `EDIT_CLAUDE` and title `GUIDANCE` (registered `EDIT_CLAUDE` is the older 197 B sentence "Explore's reads are not a Read for your Edit tool: …", measured from `instructions.after` in the bench cache's `v2/bin-g/meta.json`, not the current 154 B text; and the old title `GUIDANCE`), so re-running G2 requires re-registering its pins; `gui.mjs --batch` refuses until then. Live sizes, from `node -e` on `pandaInstructions(pandaSources())` in `gui.mjs`: plain task 6,144 characters (6,156 bytes), worker 1,329 characters. A batch on a non-Claude harness must first make the runner harness-aware and register that change; `lib.mjs` is hash-pinned by the G2 registration.

### Batch Fv2 deviations

<!-- deviation:Fv2-1 -->
**Fv2-1** (2026-11-07, after registration and before any Fv2 run). `bin-f` was rebuilt, so its pinned hashes changed:

- binary sha256 `ecbbd0c1…` → `34c3de0750ce1ecd43d534887cddb8c5f5a2abe695e85187447cf193037e1090`;
- sources sha256 `6bf059d8…` → `e92e0a7ed1c1b00aa6ab822f6755717e602d5025354481d03cb38c9bd44e9b04`.

Why: after registration, `src-tauri/src/lib.rs` changed in two places (the `REUSE` sentence now reads "If the Project tools note lists a tool that does …", and one comment), and R1's test-only bench hook was added (`custom_tools::bench_host`/`bench_note` and the ignored `custom_tools_mcp_serve`, all under `#[cfg(test)]`, in `custom_tools.rs` and `providers/mcp_host.rs`); `providers/warm.rs` also changed in its test module. The sources hash covers `lib.rs` and `mcp_host.rs`; the binary is the whole test binary. No explore engine file (`explore.rs`, `explore/`, `workspace/secret_paths.rs`) changed, and neither did what the arms are told: AFTER's `LOOK` sha256 is still `c134797c…`, AFTER-E's still `c53240c6…`. `REUSE` is not in any Fv2 arm. The batch runs on the rebuilt snapshot; nothing else changes.
<!-- /deviation:Fv2-1 -->

<!-- deviation:Fv2-2 -->
**Fv2-2** (2026-11-07, round 17). **POST-HOC: written after Fv2's results were known and published.** No registered verdict changes. Details and tables are under [the post-hoc section](#post-hoc-round-17-gate-calibration-edit-failures-and-relabelling).

1. **Gate calibration (sensitivity).** `run.mjs --simulate` gives each gate's P(pass) with no effect and with a true loss of 0.10, from BEFORE's runs in E, E2 and Fv2, with the registered design and margins. Tuned precision passes 70% of no-effect batches and edit steps 11%, so their failures are read as "not shown", not as harm. The registration's power note for edit steps (0.20 at no change) came from a simulation that resampled tasks; this one keeps Fv2's 20 tasks and gives 0.11.
2. **Edit failures classified.** 9 of 9 are agent failures, 0 build or infrastructure.
3. **Relabelling.** `--holm-cost` now applies Holm and the co-primary label to tuned localization only, uses "not shown to be lower/higher" for registered measures, and `--descriptive` (Fv2's AFTER-E commands) prints no PASS or FAIL. The three Fv2 summaries were regenerated with no number changed; the edits table lost its Holm column and the held-out steps p its "Holm 0.031". Batch E's bottom line said "Edits: more steps and more output" for results that were not significant; it now uses the wording rule.
4. **Analysis code hashes, taken after the analysis.** Registrations from now on record the sha256 of `analyze.mjs`, `metrics.mjs` and `stats.mjs` (`register()` in `lib.mjs`), and `analyze.mjs` prints `MISMATCH` when the code on disk differs from a batch's newest registered hashes. Fv2 registered none. These are the hashes of the code that produced the regenerated summaries, recorded after Fv2 was analysed, so they do not show that Fv2's analysis was fixed in advance: `analyze.mjs` `9e08daecbc349bf7d8ccdd57915455ce3bad7974d896823705ac29d4c349acad`, `metrics.mjs` `f24bafbebca21aeb10c96cfa526db163bc03142fcd537358380b836b98110cc6`, `stats.mjs` `a3b9fe4de3311271a7716b241c0ee2453e34629839a972c590202705a67a6462`. The round 17 code differs from the code that first analysed Fv2 in labels (item 3) and in one metric: an explore call whose result is an error (a refused root or path, bad arguments, a harness timeout) no longer gives recall credit through its arguments or reply (`metrics.mjs`). Credit and cost to full recall are descriptive; no gate or registered measure uses them, and the regenerated numbers did not move.
5. **Project settings.** The harness runs with `--setting-sources project` and permissions skipped, so a repo's `.claude/` settings or hooks, `.mcp.json` or `CLAUDE.md` would configure the agent. Checked for every task commit of every batch: PandaCode never had any; Hono had none; Outline had `.claude/skills/verify-outline/` and VS Code had `.mcp.json`, both removed by the repos' `prune` lists before every run, and no recorded run's `init` lists a project skill or hook. So no recorded run loaded project settings. One finding remains: Claude Code 2.1.317 has a built-in `agents-md` plugin, and every PandaCode, Outline and VS Code checkout had an `AGENTS.md`, which it may load; it was the same in every arm. From round 17 on, `materialize()` deletes `.claude/`, `.mcp.json`, `CLAUDE.md` and `CLAUDE.local.md` anywhere in the tree before the snapshot commit and records what it removed; `AGENTS.md` is kept, to keep later batches comparable. The pinned 2.1.317 `--help` lists `--setting-sources` as `user, project, local` only; `user` would load this machine's own hooks and plugins, so deleting the files was chosen.
6. **Build inputs.** From round 17, `--prepare` snapshots `Cargo.lock` and `Cargo.toml` and pins them with a fingerprint of the target's dependencies (see the post-hoc section).
<!-- /deviation:Fv2-2 -->

## Batch Fv2 results

Sonnet (`claude-sonnet-5-5`) in Claude Code 2.1.317, 2026-11-07. Snapshot `bin-f` as rebuilt in deviation Fv2-1 (`fast-release`, opt-level `s`, binary `34c3de07`, sources `e92e0a7e`); the build folder was deleted afterwards. AFTER's `LOOK` sha256 `c134797c…`, AFTER-E's `c53240c6…`, as registered.

**Smoke.** `Fv2-smoke` had run on the old binary, and a batch keeps its pins, so the smoke was rerun as `Fv2-smoke2` (`edit-sidebar-sections`, three arms, seed 99): all three ran, used their tools as expected (AFTER and AFTER-E called explore), BEFORE passed and both explore arms failed the same two `sectionOf` tests that task often fails. Smoke runs are never analysed.

**What ran.** Everything registered, at concurrency 4, with no stop, no crash, no killed run and no run excluded for its model (the analyzer reported none): 80 tuned and 32 held-out localization runs, 36 edit and 84 edit2 runs (three arms), 8 long-context runs (all with the filler read from cache). 9 runs failed their test (below); they count as failures. Billed: Fv2 **$34.62** (240 runs), smoke $0.82.

Per-run data: `scripts/agent-bench/results/runs/v6-Fv2.csv`. Summaries: `results/v6-Fv2.json` (primary, gates, edit-steps test), `results/v6-Fv2-edit-clause.json` (AFTER-E → AFTER) and `results/v6-Fv2-before-e.json` (BEFORE → AFTER-E).

### Primary, co-primary and gates (batch Fv2 alone)

**Tuned localization** (80 runs, 20 tasks; means of per-task means):

| Metric | Before | After | Mean change | 95% CI | Wilcoxon p | Holm p | max-T p | Better / worse | Read |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| **Steps** (primary) | 4.92 | 4.20 | -12% | -19% to -5% | 0.003 | 0.005 | – | 12 / 1 | **lower** |
| **Cost $** (co-primary) | 0.173 | 0.163 | -3% | -8% to +1% | 0.017 | 0.017 | – | 16 / 4 | not shown to be lower |
| Wall s | 23.15 | 18.98 | -14% | -21% to -8% | <0.001 | – | 0.004 | 17 / 3 | lower |
| API s | 21.68 | 18.10 | -13% | -20% to -6% | 0.001 | – | 0.014 | 17 / 3 | lower |
| Cache read tokens | 181,739 | 150,316 | -11% | -20% to -2% | 0.011 | – | 0.120 | 13 / 7 | not shown to be lower |
| Output tokens | 1,985 | 1,750 | -8% | -16% to -0% | 0.015 | – | 0.271 | 15 / 5 | not shown to be lower |
| Cache write tokens per step after the first (descriptive) | 2,158 | 2,339 | +11% | -2% to +27% | 0.812 | – | – | 10 / 10 | – |

The largest step savings were `loc-team-stop` (7.0 → 4.0), `loc-opencode-efforts` (7.0 → 5.0) and `loc-skill-brief` (5.5 → 3.5); `out-auth-transports` took one step more (4.0 → 5.0). Explore was adopted in 39 of 40 AFTER runs, with 2.8 calls a run, no errors and no ToolSearch.

**Gates** (margin -0.05 on the lower end of the 95% CI of the mean per-task change):

| Gate | Before | After | CI of change | Result |
|---|---:|---:|---:|---|
| Recall (tuned) | 0.794 | 0.797 | -0.043 to +0.057 | pass |
| Precision (tuned) | 0.574 | 0.562 | -0.066 to +0.040 | **fail: not shown non-inferior** |
| Edit pass (6 edits) | 0.750 (9/12) | 1.000 (12/12) | +0.083 to +0.417 | pass |
| Edit pass, edit tasks v2 (14 tasks) | 0.964 (27/28) | 0.964 (27/28) | 0.000 to 0.000 | pass |

**Edit-steps non-superiority** (registered, one test at α = 0.05; 6 edits and 14 edit2 tasks pooled): mean per-task change in steps **+2%** (95% CI -10% to +14%), one-sided Wilcoxon p = 0.32 against +5%. **Fails: edits are not shown to be no longer with the tool.** As the registration's power simulation expected for a true change near zero.

### Edits (descriptive)

| Set | Metric | Before | After | Mean change | 95% CI | Wilcoxon p | Better / worse |
|---|---|---:|---:|---:|---:|---:|---:|
| 6 edits | Steps | 6.08 | 6.08 | +4% | -11% to +20% | 1.000 | 3 / 2 |
| 6 edits | Output tokens | 2,375 | 2,401 | +2% | -3% to +7% | 0.688 | 2 / 4 |
| 6 edits | Cost $ | 0.163 | 0.165 | +1% | -4% to +5% | 0.688 | 2 / 4 |
| 14 edit2 | Steps | 6.50 | 5.96 | +1% | -15% to +17% | 0.550 | 7 / 6 |
| 14 edit2 | Output tokens | 2,114 | 2,009 | -0% | -13% to +14% | 0.194 | 9 / 5 |
| 14 edit2 | Cost $ | 0.127 | 0.121 | -3% | -11% to +5% | 0.153 | 9 / 5 |

(Post-hoc, deviation Fv2-2: an earlier version of this table had a Holm p column. Holm belongs to the tuned localization pair only, so it was dropped here; no other number changed.)

On the 6 edits one task tied on steps, leaving 5, so the smallest two-sided p was 0.0625; no edit p-value reaches 0.05 and none is read as a change. Edit2 wall time fell 16% (CI -37% to +6%), within noise.

Failed runs: BEFORE `edit-connect-secrets` s11, `edit-projects-added-order` s11, `edit-sidebar-sections` s11, `e2-opencode-cache-pin` s11; AFTER `e2-opencode-cache-pin` s12; AFTER-E `edit-connect-secrets` s12, `edit-projects-added-order` s11, `edit-sidebar-sections` s12, `e2-boat-trial-ttl` s12.

### AFTER-E: the new `LOOK` against E's, same engine (descriptive)

| Set | Metric | AFTER-E | AFTER | Mean change | 95% CI | Wilcoxon p | Better / worse |
|---|---|---:|---:|---:|---:|---:|---:|
| 6 edits | Steps | 6.58 | 6.08 | -5% | -16% to +5% | 0.625 | 2 / 2 |
| 6 edits | Output tokens | 2,497 | 2,401 | -3% | -13% to +10% | 0.313 | 5 / 1 |
| 6 edits | Cost $ | 0.17 | 0.17 | -3% | -7% to +3% | 0.156 | 5 / 1 |
| 6 edits | Pass | 9/12 | 12/12 | | | McNemar 0.25 | |
| 14 edit2 | Steps | 5.93 | 5.96 | +2% | -5% to +9% | 0.629 | 4 / 6 |
| 14 edit2 | Output tokens | 1,984 | 2,009 | +3% | -6% to +13% | 0.808 | 7 / 7 |
| 14 edit2 | Cost $ | 0.12 | 0.12 | +1% | -5% to +7% | 0.855 | 7 / 7 |
| 14 edit2 | Pass | 27/28 | 27/28 | | | | |

BEFORE → AFTER-E: 6 edits steps +11% (CI -7% to +28%, p = 0.44), cost +4% (CI -2% to +10%); edit2 steps -2% (CI -15% to +11%), cost -3% (CI -12% to +7%); passes 9/12 → 9/12 and 27/28 → 27/28. Every CI spans zero.

### Held-out localization (32 runs, 8 tasks; descriptive, never pooled)

| Metric | Before | After | Mean change | 95% CI | Wilcoxon p | Read |
|---|---:|---:|---:|---:|---:|---|
| Steps | 5.44 | 4.25 | -21% | -33% to -10% | 0.016 | descriptive |
| Cost $ | 0.12 | 0.11 | -3% | -12% to +5% | 0.641 | descriptive |
| Wall s | 23.24 | 18.67 | -19% | -25% to -11% | 0.016 (max-T 0.016) | descriptive |
| Recall | 0.880 | 0.885 | +0.005 | -0.031 to +0.047 | – | descriptive (CI clears -0.05) |
| Precision | 0.703 | 0.702 | -0.001 | -0.041 to +0.034 | – | descriptive (CI clears -0.05) |

7 tasks took fewer steps and none more. Held-out precision, which failed its margin in E, E2 and pooled, clears it here. (Post-hoc correction: every held-out read is "descriptive", as the section title says; the table used to say "lower" and "gate: pass". No number changed.) (Post-hoc, deviation Fv2-2: the steps p was printed as "Holm 0.031"; Holm is not applied outside tuned localization, and the read is unchanged.)

### Long context (8 of 8 valid, 4 tasks × 1 seed; descriptive)

Steps 4.75 → 3.50 (-23%, CI -37% to -8%, Wilcoxon p = 0.25), cost after the filler turn $0.16 → $0.12 (-22%, CI -30% to -15%, p = 0.125), duration -30%, output tokens -19%. Recall: `loc-cloud-credentials` 0.67 → 1.00, `loc-model-picker-errors` 0.50 → 1.00, the other two equal. With 4 tasks the smallest possible p is 0.125, so nothing is shown.

<a id="post-hoc-round-17-gate-calibration-edit-failures-and-relabelling"></a>

### POST-HOC: gate calibration, edit failures and relabelling

**POST-HOC: written on 2026-11-07, after Fv2's results were known, as deviation Fv2-2.** Nothing here changes a registered verdict: precision and edit steps still fail as registered.

**Gate calibration.** `run.mjs --simulate` (it replaces the old `_pow.mjs`; summary `scripts/agent-bench/results/v6-Fv2-gate-calibration.json`) simulates each Fv2 gate with Fv2's design (2 seeds per arm, the registered margins, the gates' own bootstrap at 2000 rounds) from BEFORE's own runs in E, E2 and Fv2 (tuned localization: 120 runs; 6 edits: 36; edit2: Fv2 only, 28; edit steps: 64). Recall and precision resample each task's runs; pass rates are Bernoulli at each task's shrunk rate (passes + 0.5) / (runs + 1), and the observed rates are shown beside them; edit steps use each task's mean times per-run noise, as the registration's own power note did. 1000 simulated batches per cell (400 for edit steps).

| Gate (margin) | P(pass), no effect | P(pass), true loss 0.10 | Fv2 result |
|---|---:|---:|---|
| Recall, tuned (−0.05) | 0.93 | 0.00 | pass |
| Precision, tuned (−0.05) | **0.70** | 0.00 | fail |
| Edit pass, 6 edits (−0.05) | **0.26** (observed rates 0.36) | 0.09 (0.13) | pass |
| Edit pass, edit2, 14 tasks (−0.05) | **0.10** (observed rates 0.68) | 0.01 (0.04) | pass |
| Edit steps non-superiority (+5%) | **0.11** | 0.00 at +10% steps (0.71 at −10%) | fail |

**Reading rule for Fv2's failures.** A gate that a no-effect tool passes less than about 80% of the time cannot tell "no effect" from "harm" by failing. So:
- **Tuned precision** fails 30% of no-effect batches. Its failure (CI −0.066 to +0.040) is read as "not shown non-inferior", consistent with no effect, not as evidence of a loss. It would almost never pass with a true loss of 0.10.
- **Edit steps** passes only 11% of no-effect batches; it is built to pass only when edits got shorter. Its failure (+2%, CI −10% to +14%) says nothing beyond "not shown to be no longer".
- **The edit pass gates** are weaker still (0.26 and 0.10 with shrinkage; edit2's 13 of 14 tasks never failed, so with observed rates it passes 0.68). Their passes in Fv2 are weak evidence: a gate that passes 26% (6 edits) or 10% (edit2) of no-effect batches, and 9% and 1% with a true loss of 0.10, says little either way. (Post-hoc correction: this line used to call the 6-edit pass "real evidence against a large loss".) Failures in a later batch would mostly be noise.
- A later batch should size its gates from this simulation before it registers, as S1v3 did.

**Edit failures: build or infrastructure, or agent.** All 9 failed runs (from each run's `run.json` grade and transcript) exited 0 with a `success` result, no timeout and no harness error:

| Run | Failure | Cause |
|---|---|---|
| BEFORE `edit-connect-secrets` s11, AFTER-E `edit-connect-secrets` s12 | build (E0425) | agent: the prompt names `const LOCK: &str = "connect-secrets.lock"`, the agent used another name, so the commit's test module could not find `LOCK`. The crate itself built. |
| BEFORE `e2-opencode-cache-pin` s11, AFTER `e2-opencode-cache-pin` s12 | assertion | agent: the fix compiled and the agent's own module tests passed (s11 ran them), the hidden test failed |
| AFTER-E `e2-boat-trial-ttl` s12 | assertion | agent: the agent did not compile or test |
| BEFORE and AFTER-E `edit-projects-added-order` s11 | assertion | agent |
| BEFORE `edit-sidebar-sections` s11, AFTER-E s12 | assertion | agent: the two `sectionOf` tests this task often fails |

**Build/infrastructure: 0 of 9. Agent: 9 of 9** (2 of them compile errors in the agent's own change). For later batches `--prepare` now copies `Cargo.lock` and `Cargo.toml` into the snapshot and pins their sha256 and a fingerprint of `src-tauri/target/debug/deps` (`snapshotBuild`), which `batch.json` and every run record; a Rust run refuses to start if the target's dependencies drifted. Fv2 used the live tree's manifests and target, which no failure points to.

**Relabelling (`analyze.mjs --holm-cost`).** Holm and the primary/co-primary labels now apply only to tuned localization, as registered; elsewhere steps and cost carry their plain Wilcoxon p and cost stays out of the max-T family, so no number changes. Registered measures read "not shown to be lower/higher", never "within noise"; descriptive measures read "descriptive". Fv2's AFTER-E comparisons run with `--descriptive`, which prints no PASS or FAIL. `v6-Fv2.json`, `v6-Fv2-edit-clause.json` and `v6-Fv2-before-e.json` were regenerated: every number is unchanged; only `pHolm` outside tuned localization, `primary`, `read` and the descriptive files' `pass` fields changed. The tables above were edited to match.

### Spend

Fv2 billed $34.62 and its smoke $0.82. The v2 ledger (all rounds, in-flight caps released) stood at $172.61 when Fv2 ended.


## Batch R1 (pilot): pre-registration

<!-- prereg:R1 -->
Written on 2026-11-07, before any R1 run. **Descriptive only**: R1 tests no hypothesis and has no gate. It measures how agents use agent-made tools ([docs/custom-tools.md](custom-tools.md)) and the `REUSE` instruction across a short sequence of tasks in one project, to size a later confirmatory batch. Claude Code only, as Fv2.

**Blocked on one native hook.** The bench MCP server (`explore_mcp_serve` in `src-tauri/src/providers/mcp_host.rs`) serves only `pandacode_explore`. The tools need a store, a project and an author, which only the app wires up (`with_custom_tools`, `message_note`). R1 runs once these exist, all under `#[cfg(test)]`:
1. In `src-tauri/src/custom_tools.rs`, `bench_host(base: Option<ToolHost>, tools_dir: PathBuf, project: &str, root: PathBuf, session: &str) -> ToolHost`. It is `test_host` with a base host to compose onto, and with `full: true`, so a run never waits for an approval.
2. In the same file, `bench_note(tools_dir: &Path, project: &str) -> Option<String>`: `host::note_text(&host::catalog_text(visible(tools_dir, project)))`, the catalog note `message_note` adds to a task's first message in the app (each R1 task is a new thread, so `note_due` is always true).
3. In `mcp_host.rs`, an ignored `custom_tools_mcp_serve` beside `explore_mcp_serve`. It serves `bench_host(Some(explore_host(root)), …)` from `PANDACODE_BENCH_TOOLS` (the store), `PANDACODE_BENCH_PROJECT` and `PANDACODE_BENCH_SESSION`. Before it writes the config, it writes `bench_note(…)` (or nothing) to `PANDACODE_BENCH_NOTE`.

No other native change is needed. The runner side is a `--set reuse` in `run.mjs` (about one function, not written until the hook exists):
- it starts that server instead of `explore_mcp_serve`;
- it appends the note to the task message, as the app does;
- it adds `REUSE` (`reuseClause()` in `lib.mjs`, read from `lib.rs`) after `LOOK` for the TOOLS arm.

**Tasks.** Three PandaCode Rust edits from `tasks-edit-v2.json`, committed within 3 seconds of each other on 2026-11-01, in this fixed order:
1. `e2-boat-trial-ttl` (`cargo test --lib cloud::boat::`)
2. `e2-pnpm-global-bin` (`cargo test --lib providers::launch::`)
3. `e2-do-ssh-key` (`cargo test --lib cloud::digitalocean::`)

All three passed `--sanity` (`ok`). They share one check chain, which each prompt gets appended in the same words: "Before you finish, check your change from src-tauri: run cargo fmt on the files you changed, then cargo check --lib, then cargo test --lib with the module you changed as the filter." That is the recurring multi-step sequence `REUSE` is about. Grading is `gradeEdit`, as in Fv2.

**Chains.** One chain is the 3 tasks in order, run by one arm under one seed. Each task gets its own checkout of its own parent commit, but all 3 share one project id and one tool store (`<out>/runs/R1/<arm>-s<seed>/tools`). A tool saved in task 1 is therefore offered in tasks 2 and 3. Each task runs in its own harness process, as a new thread would.

**Arms.**
- `NONE`: the AFTER arm of Fv2 (explore and `LOOK`), with no custom tools and no `REUSE`.
- `TOOLS`: the same, plus `pandacode_tool_list`, `pandacode_tool_save` and `pandacode_tool_run` from the per-run server, `REUSE` after `LOOK`, and the catalog note on each message. The store starts empty in every chain.

**Seeds.** 21 and 22, never used. 2 arms × 2 seeds × 3 tasks = **12 runs**. The chain order is fixed; the arm order per seed comes from the batch seed.

**Measures, per task position (1, 2, 3) and arm, with each chain's runs listed:**
- steps;
- `pandacode_tool_run` calls. In the app's Standard mode each is an approval prompt; the bench runs in Full access, so this counts the prompts a user would have seen;
- `pandacode_tool_save` calls, and the tools in the store after each task;
- cache writes per step after the first (`laterWrites`), and the first step's cache write. The catalog note changes the message whenever the store changes;
- billed cost, output tokens and pass (`gradeEdit`).

**Reading.** Means and per-chain values only, with no p-values. The pilot reports whether TOOLS saved a tool in task 1 or 2, whether tasks 2 and 3 ran it, and the step and cache-write differences at positions 2 and 3. It sizes a later registered batch and never makes a claim of its own.

**Cost.** About $3 at Fv2's edit means ($0.17 a run, more for these Rust builds); cap $10 a run.
<!-- /prereg:R1 -->

### Batch R1 deviations

<!-- deviation:R1-1 -->
**R1-1** (2026-11-07, after registration and before any R1 run).

1. **`REUSE` changed after registration.** It now reads: "If the Project tools note lists a tool that does a multi-step command sequence you need, run it; after doing the same sequence twice, or once when it will clearly recur, save it with pandacode_tool_save." The TOOLS arm gets it as the registration says, read from `lib.rs` at `--prepare` (`reuseClause()`), after `LOOK` with a blank line between, as `app_instructions` joins them. TOOLS' instruction sha256 is `3e6532792cc3c929a10b2d8da5e304dbebebb4088192317182f73831ff39ab53`; NONE's is AFTER's `LOOK`, `c134797c…`.
2. **The snapshot is the rebuilt `bin-f`** (Fv2-1: binary `34c3de07…`, sources `e92e0a7e…`), which now holds the hook.
3. **Runner details the registration left open.**
   - One pool job is one chain: its 3 runs in order, each with its own ledger entry and cap, so the pool reserves 3 caps for a chain. A resumed chain skips finished runs and keeps its store.
   - The TOOLS server gets the run's `CARGO_TARGET_DIR` and `CARGO_INCREMENTAL=0`, the agent's own, since a saved tool runs in the server's environment as it runs in the app's.
   - Arms are named `none` and `tools`; the project id is `bench-r1`; each run's session id is its run id.
   - Each run records `reuse`: position, chain, whether a note was sent, the tools in the store before and after, and `pandacode_tool_list`/`_save`/`_run` calls by the main agent.
   - Command: `run.mjs --batch R1 --snapshot bin-f --set reuse --edit-v2 --seeds 21,22 --run-cap-usd 10 --total-budget-usd 100000`.
<!-- /deviation:R1-1 -->

<!-- deviation:R1-2 -->
**R1-2** (2026-11-07, round 17). **POST-HOC: written after R1's results were known.** Nothing in R1's reading changes. R1 registered no analysis code hashes; those of the code that now reproduces `results/r1-reuse.json` (`analyze.mjs --reuse`), recorded after R1 was analysed, are `analyze.mjs` `9e08daecbc349bf7d8ccdd57915455ce3bad7974d896823705ac29d4c349acad`, `metrics.mjs` `f24bafbebca21aeb10c96cfa526db163bc03142fcd537358380b836b98110cc6`, `stats.mjs` `a3b9fe4de3311271a7716b241c0ee2453e34629839a972c590202705a67a6462`. R1's checkouts were PandaCode commits, which never held `.claude/`, `.mcp.json` or `CLAUDE.md`, so no R1 run loaded project settings (the `AGENTS.md` note in Fv2-2 applies).
<!-- /deviation:R1-2 -->

## Batch R1 results (descriptive)

Sonnet in Claude Code 2.1.317, 2026-11-07, snapshot `bin-f` (Fv2-1), as registered with deviation R1-1. **Descriptive only: no p-values, no claim.**

**Smoke** (`R1-smoke`, seed 99, both arms, all 3 tasks, never analysed): every run passed; TOOLS listed `pandacode_tool_list`, `_save` and `_run` beside explore, NONE only explore; no agent called a tool. Billed $1.34.

**What ran.** 4 chains (2 arms × seeds 21 and 22), 12 runs, all finished, none stopped or excluded. Billed **$2.78**. Per-run data: `scripts/agent-bench/results/runs/r1-R1.csv`; summary: `results/r1-reuse.json` (`analyze.mjs --reuse`).

**The headline: no agent saved or ran a tool.** In all 6 TOOLS runs (and the 3 smoke TOOLS runs), `pandacode_tool_save`, `_run` and `_list` were called 0 times; both stores stayed empty, so no catalog note was ever sent. Every one of the 12 runs instead ran the whole check chain itself in a single Bash call (`rustfmt …; cargo check --lib …; cargo test --lib <module>`). Positions 2 and 3 therefore had nothing to reuse, and TOOLS differed from NONE only by the `REUSE` sentence and three listed tools.

| Position | Task | Arm | Steps | Tool saves | Tool runs | Tools in store after | First cache write | Cache write per later step | Cost $ | Output tok | Passes |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | `e2-boat-trial-ttl` | NONE | 6.5 | 0 | 0 | 0 | 33,972 | 1,923 | 0.229 | 2,299 | 0/2 |
| 1 | `e2-boat-trial-ttl` | TOOLS | 7.0 | 0 | 0 | 0 | 34,971 | 1,624 | 0.232 | 2,202 | 1/2 |
| 2 | `e2-pnpm-global-bin` | NONE | 5.5 | 0 | 0 | 0 | 34,087 | 2,119 | 0.226 | 2,779 | 2/2 |
| 2 | `e2-pnpm-global-bin` | TOOLS | 5.5 | 0 | 0 | 0 | 34,149 | 1,862 | 0.218 | 2,460 | 1/2 |
| 3 | `e2-do-ssh-key` | NONE | 6.0 | 0 | 0 | 0 | 34,052 | 2,225 | 0.246 | 3,815 | 2/2 |
| 3 | `e2-do-ssh-key` | TOOLS | 5.5 | 0 | 0 | 0 | 34,119 | 2,399 | 0.239 | 3,660 | 2/2 |

Per chain (steps at positions 1, 2, 3; pass ✓/✗):

| Chain | Steps | Passes | Cost $ |
|---|---|---|---:|
| NONE s21 | 7, 6, 6 | ✗ ✓ ✓ | 0.691 |
| NONE s22 | 6, 5, 6 | ✗ ✓ ✓ | 0.712 |
| TOOLS s21 | 8, 5, 5 | ✓ ✓ ✓ | 0.702 |
| TOOLS s22 | 6, 6, 6 | ✗ ✗ ✓ | 0.676 |

- The 4 failures are test failures (`keep_alive_falls_back_to_the_free_trial_cap` three times, `platform_search_uses_real_windows_profile_and_appdata_locations` once), not harness errors.
- TOOLS' first cache write is about 1,000 tokens larger at position 1 (the three tool specs and `REUSE`), and about 60 larger at positions 2 and 3, where the specs had been cached by then. No note was ever sent, so the note's cache cost was not observed.
- **Reading for a later batch.** With this `REUSE` wording and a check chain that fits in one Bash command, Sonnet did not judge the chain worth saving even after doing it once per task. A confirmatory batch would measure nothing as things stand. It needs a sequence the agent repeats as several separate steps, or wording that names the trigger more directly, and a pilot first showing that tools get saved at all.
