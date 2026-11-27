# 06 · Evaluating and improving agent quality on the user's own machine

Research note for PandaCode. No code changes. Web access available; sources checked 2026-11-27.

Tags: **[shipped]** production at a major vendor · **[benchmark]** widely reproduced public
benchmark · **[paper]** peer-reviewed/camera-ready · **[preprint]** arXiv, not replicated ·
**[tooling]** practitioner evidence only.

PandaCode surfaces named below are real: `src-tauri/src/usage_ledger.rs` (`Ledger`, `Row`, `TaskUsage`)
with `src-tauri/src/task_usage.rs`; the Council (`src-tauri/src/architect/council.rs`, `src/council.ts`,
the `finish_team` gate, `councilStatus`); `src-tauri/src/checks.rs` / `src/turn-checks.ts`;
`turn_changes` + `turn_change_files` + `pandacode_track_files`; `src-tauri/src/model_health.rs`;
`src-tauri/src/schedules.rs` (`task_schedule_runs`); the skills library (`<app data>/skills/<id>`,
`skills_matrix`); recipes (`.pandacode/recipes/<name>.json`); `src-tauri/src/model_routing.rs`
(`p_success`, `p_success_lower`); and `src/settings-recommendations.ts`.

## 0. The facts that should drive the roadmap

| # | Finding | Number | Source |
|---|---|---|---|
| 1 | Public coding benchmarks no longer measure coding | SWE-bench Verified: **59.4%** of an audited 138-problem subset has material flaws (35.5% too-narrow tests, 18.8% too-wide); all frontier models tested could reproduce gold patches | [OpenAI, Feb 2026](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/) **[shipped]** |
| 2 | Harder, cleaner benchmarks collapse scores | SWE-bench Pro: GPT-5 **23.3%**, Opus 4.1 **23.1%**, GPT-4o **4.9%**; commercial subset GPT-5 **14.9%** | [Scale](https://scale.com/blog/swe-bench-pro) **[benchmark]** |
| 3 | Long-horizon terminal work is unsolved too | Terminal-Bench 2.0 (89 tasks): frontier models and agents score **<65%** in the paper | [arXiv:2601.11868](https://arxiv.org/abs/2601.11868) **[paper]** |
| 4 | One-shot success ≠ reliability | τ-bench: gpt-4o **<50%** pass@1 and **pass^8 <25%** in retail | [arXiv:2406.12045](https://arxiv.org/abs/2406.12045) **[paper]** |
| 5 | Judges can match humans — if you control them | GPT-4 judge **>80%** agreement with human preference, equal to human–human; same paper documents position, verbosity and self-enhancement bias | [MT-Bench / Arena](https://arxiv.org/abs/2306.05685) **[paper, NeurIPS'23]** |
| 6 | Panels beat a single big judge | Panel of smaller models (PoLL) outperforms one large judge with less intra-model bias | [PoLL](https://arxiv.org/abs/2404.18796) **[paper]** |
| 7 | Eval numbers are noisy unless you say otherwise | Clustered standard errors up to **3×** naive; paired analysis is a free variance cut; ~**969** questions for a 3-point effect at 80% power | [Miller, arXiv:2411.00640](https://arxiv.org/abs/2411.00640) **[preprint, statistical methods]** |
| 8 | Reflective prompt evolution beats RL at a fraction of the cost | GEPA: **+6%** average (up to **+20%**) over GRPO with **up to 35× fewer rollouts**; **+10%** over MIPROv2; **~33%** shorter prompts | [arXiv:2507.19457](https://arxiv.org/abs/2507.19457) **[paper, ICLR'26 oral]** |

Why this matters here: PandaCode is local-first with **no accounts, no telemetry**. It cannot run an
online A/B test over user traffic, and it must never phone home. The only honest quality loop is
**offline replay over trajectories the machine already saved** (`messages`, `turn_changes`,
`architect_workers`, `usage_ledger` rows). Everything below is filtered by that constraint.

## 1. What the benchmarks actually measure (and why none can be adopted as-is)

**What.** SWE-bench Verified (500 human-filtered issues from 12 Python repos, Aug 2024) grades a patch
by running repo tests; a pass needs fail-to-pass plus pass-to-pass. Terminal-Bench 2.0 grades 89
containerised CLI tasks with human-written solutions and tests. τ-bench/τ²-bench grade a **database end
state** after a simulated multi-turn conversation (τ² adds dual control: the user also calls tools).
WebArena (URL + page + backend state), OSWorld (369 execution-checked tasks, 12.24% best model vs
72.36% human) and GAIA (92% human vs 15% GPT-4+plugins) grade outcomes in a live environment.

**Evidence — four caveats that apply to anything PandaCode builds.**

1. **Contamination is documented, not hypothetical.** OpenAI's Feb 2026 audit stopped reporting
   Verified after finding models reproduce gold patches and release-note details from memory
   (**[shipped]**). Scale's answer was licensing: GPL/private repos whose "viral" terms keep them out of
   training data (**[benchmark]**).
2. **The grader, not the agent, is usually the bug.** Anthropic reports Opus 4.5 scoring **42%** on
   CORE-Bench until rigid grading (rejecting `96.12` for `96.124991…`), ambiguous specs and stochastic
   tasks were fixed — then **95%**; and a Terminal-Bench audit where an unstated output filepath failed
   a correct solution. **[shipped]**
3. **Zero pass rate usually means a broken task.** A 0% pass@100 is "most often a signal of a broken
   task, not an incapable agent". **[shipped]**
4. **Saturation hides progress.** Verified went 74.9% → 80.9% in six months; the residual is mostly
   noise, so small score moves stop meaning anything. **[shipped]**

**Fit.** PandaCode has no benchmark suite and should not import one. It has something better: the
user's own repository, their declared check (`checks.rs::plan`), and real diffs in `turn_changes`. The
lesson to take is *method* — reference solutions, unambiguous criteria, isolated runs — not any
dataset. **Cost.** S for the method; L for any environment. Local.

**Proposal.** A one-page eval policy in `docs/` (no code): every task in a PandaCode-built suite needs
a reference solution that passes, a criterion two experts would grade identically, and a clean start
per trial; SWE-bench Verified is explicitly banned as a target, with the reason.

**Signal.** The policy exists and a reviewer can point at the clause forbidding a suite whose
reference solution fails.

## 2. Trajectory-level vs outcome-level evaluation

**What.** Outcome grading inspects the end state (tests pass, file written, DB row exists). Trajectory
grading inspects the transcript (tool calls, turns, tokens). Anthropic's taxonomy: code-based,
model-based and human graders, each scoring one or the other. **[shipped]**

**Evidence.** That guide warns against grading exact tool sequences — agents find valid paths designers
didn't anticipate — but endorses transcript *metrics* (`n_turns`, `n_toolcalls`, tokens) and partial
credit. AgentRewardBench (1,302 expert-reviewed trajectories, 12 judges) found **no single judge wins
across benchmarks**, and that rule-based outcome checks **underreport** success by missing valid
alternative paths ([arXiv:2504.08942](https://arxiv.org/abs/2504.08942)) **[paper]**. Both directions
have a known bias: rigid rules under-credit, judges over-credit.

**Fit.** PandaCode stores both halves: `turn_changes` + `turn_change_files` (outcome, with `lastWriteAt`
and diff bytes) and `messages` (transcript, with `turn_duration_ms`). But the Council reads **only the
outcome prose** and asks for a number out of 10 — trajectory judgement with no execution anchor.

**Cost.** S. Read-only SQL over existing tables; no new storage.

**Proposal.** Add an outcome column beside Council scores: `turn_changes` file count, whether
`checks.rs` ran and passed, whether tests were modified. Render `verified` / `checked` / `unchecked`
next to the score instead of a bare `9.0`, reusing note 03's labels.

**Signal.** A Council pass on a turn that edited a test file renders `checked`, not `verified`; a
snapshot test locks the three labels.

## 3. pass@k, pass^k, and flake handling

**What.** pass@k = probability at least one of k trials succeeds (rises with k). pass^k = probability
**all** k succeed (falls with k). At 75% per-trial success, pass^3 ≈ 42%. Now standard in serious agent
benchmarks. **[shipped]**

**Evidence.** τ-bench introduced pass^k precisely because pass@1 hid unreliability (**[paper]**).
Anthropic's rule: pass@k where one success is enough, pass^k where the user expects it to work every
time — PandaCode's case, since the user is watching one run.

**Fit.** PandaCode has no repeated trials: one turn, one score. `checks.rs` also runs once, so a flaky
suite yields a false failure and a wasted repair turn. `task_schedule_runs` already records `outcome`
per run, so scheduled repeats are the natural source of k>1 samples.

**Cost.** S for reporting; M for a repeat runner. Rust scheduler + TS display. Local, and each repeat
costs real tokens, so it must be opt-in and budgeted.

**Proposal.** A per-task "reliability" experiment that re-runs one saved prompt k≤5 times through the
existing scheduler and reports pass@1 and pass^k. Separately, classify a check failure as **flake**
when the same command passes on one immediate retry on an unchanged tree, and say so in `repairPrompt`
instead of queueing a repair.

**Signal.** A test that fails once and passes on retry is labelled flake and queues no repair; a
deterministic failure still queues one. Fixture test locks both paths.

## 4. LLM-as-judge, done properly

**What.** Use a model to score output against a rubric, pairwise against a baseline, or as one seat
in a panel.

**Evidence — what the literature actually supports.**

- **Agreement is achievable.** GPT-4 judging reaches >80% agreement with humans, equal to human–human,
  *when* position bias is countered by swapping order and ties are allowed (**[paper]**).
- **Bias is systematic, not random.** "Judging the Judges" (15 judges, ~150,000 instances) found
  position bias varies by judge and task and is *not* chance
  ([arXiv:2406.07791](https://arxiv.org/abs/2406.07791)) **[paper]**; CALM enumerates 12 bias types
  including verbosity and self-enhancement ([arXiv:2410.02736](https://arxiv.org/abs/2410.02736)).
- **Length bias is correctable.** Length-controlled AlpacaEval lifts Spearman correlation with Arena
  from **0.94 → 0.98** ([arXiv:2404.04475](https://arxiv.org/abs/2404.04475)) **[paper, COLM'24]**.
- **Panels beat a single judge.** PoLL: a panel of smaller models beats one large judge, with less
  intra-model bias and **over 7× cheaper** (**[paper]**).
- **Isolate dimensions and allow abstention.** Anthropic: one isolated judge per rubric dimension, a
  structured rubric, an explicit "Unknown" escape; calibrate against human labels once, spot-check
  after. **[shipped]**
- **Inter-rater reliability has a standard.** Krippendorff's α handles any number of raters, missing
  data and ordinal scales; α ≥ 0.667 is tentative, ≥ 0.8 reliable
  ([Appen](https://www.appen.com/blog/krippendorffs-alpha),
  [CASRAI](https://casrai.org/guides/krippendorffs-alpha)).

**Fit.** Council is the obvious home and the obvious liability. Today a seat reads the work and emits
`Council score: N/10`; `finish_team` takes the **lowest** score, so one grumpy reviewer with a verbosity
bias can hold a team forever. There is no rubric, no order swap, no agreement statistic, no human
calibration set, and scores from different lenses are compared as if on the same scale.

**Cost.** M. Mostly TS (`src/council.ts`, `src/council-panel.ts`) plus a rubric file format; Rust only
to persist rubrics and calibration results.

**Proposal — four changes, each independently shippable.**
1. **Rubric library.** A small file per lens with named dimensions and anchors (what a 7 looks like vs
   a 9). Seats score per dimension; the 0–10 headline is derived, not freehand.
2. **Order swap** for comparative judgements, and an explicit `unknown` that does not count toward
   `lowest`.
3. **Agreement.** Per round, Krippendorff's α across seats on the same lens, shown on the card; below
   0.667 it reads "reviewers disagree" instead of a confident number.
4. **Calibration set.** A few past turns with human-assigned scores; "Calibrate" re-scores them and
   reports α against the human labels.

**Signal.** A round where seats differ by ≥3 points shows "reviewers disagree (α = 0.4)" and stops
calling the lowest score authoritative; a unit test computes α on a fixed matrix and matches a
hand-worked value.

## 5. Statistical honesty: don't ship on noise

**What.** Treat an eval as an experiment: report a standard error, compare models on **paired**
differences, and size the suite before believing a delta.

**Evidence.** Miller (arXiv:2411.00640) gives the toolkit: Bernoulli SE `sqrt(p(1-p)/n)`, clustered SEs
when questions come in groups (**3×** larger on real data), paired differences as a "free" variance
reduction when two systems agree on which tasks are hard, a sample-size formula (~969 questions for a
3-point effect), and an explicit warning **not** to lower temperature to reduce variance — it shifts
variance into the term you can't control and can bias the estimate. "AI Agents That Matter" makes the
parallel point: accuracy-only reports ignore cost and use inadequate holdouts, producing fragile SOTA
claims ([arXiv:2407.01502](https://arxiv.org/abs/2407.01502)) **[paper]**.

**Fit.** Every comparison PandaCode could make is small-n: 15 tasks in a project, not 2,000. A sidebar
badge saying "quality down 4%" from 12 turns is worse than no badge. `model_routing.rs` already ships
the right instinct — `p_success_lower` beside `p_success`, a conservative bound rather than a point
estimate.

**Cost.** S. Pure TS module, no dependencies (seeded bootstrap over arrays).

**Proposal.** One small statistics module used everywhere a comparison is shown: paired bootstrap (10k
resamples, fixed seed) over per-task scores, a 95% interval, and a rule that a difference is reported
only when the interval excludes zero; the sidebar says "no clear change" otherwise.

**Signal.** Unit tests with synthetic arrays: identical systems produce an interval containing zero
100% of the time; a planted 3-point shift on n=30 is detected; output is stable across runs.

## 6. Sampled production traffic, shadow and counterfactual evaluation

**What.** Score a sample of real runs instead of a synthetic suite; shadow-evaluate a new
prompt/model on replayed inputs without showing the user; then canary a fraction.

**Evidence.** The practitioner funnel: offline baseline → shadow scoring → canary → full online test →
CI gate, each isolating one layer (prompt, model, config)
([Atlan](https://atlan.com/know/ab-testing-llm-applications/) **[tooling]**); MLflow frames canary as
"regression detection on the real prompt distribution" rather than preference measurement
(**[tooling]**). Off-policy evaluation is blunt about the limit: OPE is "fundamentally limited by the
available offline data" ([PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC12700629/)) **[paper]** —
replaying logs cannot answer questions the logs never explored.

**Fit.** PandaCode is the ideal *and* the worst case: every trajectory is local (ideal), but there is no
traffic to split and no server to split it with (worst). Shadow-scoring a *replayed* prompt through a
second configuration is useful; two live models per turn doubles spend silently, contradicting the
no-surprise-cost posture.

**Cost.** M. Replay runner in Rust reusing the provider runner; results into SQLite. Local, but **paid
inference**, so opt-in per experiment with a stated budget.

**Proposal.** "Replay evaluation": pick k saved prompts from a project, run them against candidate
configurations (model, effort, prompt pack) with the *current* config as baseline in the same run, grade
by outcome (check pass, diff size, tokens) and paired comparison, then show the paired interval. Nothing
reaches the user's thread; artefacts go to a scratch worktree.

**Signal.** A replay of 12 prompts produces a table with per-prompt outcome and a paired interval;
cancelling mid-run leaves no task state behind; cost is shown before it starts.

## 7. Automatic prompt optimisation: real gains vs real cost

**What.** Optimise the prompt text against a metric, either by Bayesian search over instructions and
demos (MIPROv2/DSPy) or by reflective evolution over traces (GEPA), or by an agentic proposer editing
harness code (Meta-Harness).

**Evidence.**
- **MIPROv2** beat baseline optimisers on **5 of 7** multi-stage programs, by up to **13%** accuracy, on
  Llama-3-8B ([arXiv:2406.11695](https://arxiv.org/abs/2406.11695)) **[paper, EMNLP'24]**.
- **GEPA** beat GRPO by **6%** on average and up to **20%** with **up to 35× fewer rollouts**, beat
  MIPROv2 by **>10%** (+12% on AIME-2025), and produced prompts **~33% shorter**. The whole GPT-4.1-mini
  table cost GEPA **$86**, MIPROv2 **$76** **[paper, ICLR'26 oral]**. Cross-model transfer held: prompts
  optimised on Qwen3-8B gained **+9%** on GPT-4.1-mini.
- **Meta-Harness** searches harness *code*: +7.7 points over a SOTA context manager with 4× fewer
  context tokens, +4.7 on IMO-level maths across five held-out models, and beats hand-engineered
  baselines on Terminal-Bench 2.0 ([arXiv:2603.28052](https://arxiv.org/abs/2603.28052)) **[preprint]**.
- **The counterweight.** Intrinsic self-correction *without* external feedback often degrades reasoning
  ([Huang et al.](https://arxiv.org/abs/2310.01798)) **[paper, ICLR'24]**. Reflexion's 91% HumanEval
  came from *execution* feedback, not the model re-reading itself **[paper]**.

**Fit.** PandaCode cannot ship DSPy or an optimiser loop, and has no metric plumbing to hand one. But it
has what GEPA needs — saved traces and a feedback signal (check output, diff) — and a place for the
artefact: the skills library, already a Markdown bundle with provenance and a matrix.

**Cost.** S for a reflection-only rewriter (one call per batch of failures, propose an edit, show a
diff); L for a real search loop.

**Proposal — "prompt reflection", not prompt search.** A Settings action that takes N failures from one
project's history, produces a *proposed* instruction or rule edit as a diff, and requires explicit
acceptance before anything is written. Never auto-applies, and never optimises against the Council's
judgement alone (Huang's caveat) — only against outcomes the file system can confirm.

**Signal.** On a seeded project with three failures sharing one root cause, the proposal names that
cause and the diff is <15 lines; rejecting it leaves the rule file byte-identical.

## 8. Experiential learning: playbooks, skill libraries, failure taxonomies

**What.** Turn past trajectories into reusable guidance: an evolving playbook (ACE), a library of
executable skills (Voyager), a reasoning memory of successes and failures (ReasoningBank), or a
failure-mode taxonomy.

**Evidence.**
- **ACE** treats context as an evolving playbook with incremental generation/reflection/curation:
  **+10.6%** on agents, **+8.6%** on finance, **without labelled supervision**, using natural execution
  feedback. It names the failure modes it avoids — *brevity bias* and *context collapse* (iterative
  rewriting erodes detail) ([arXiv:2510.04618](https://arxiv.org/abs/2510.04618)) **[paper, ICLR'26]**.
- **Voyager** pairs an ever-growing skill library of executable code with automatic curriculum
  ([arXiv:2305.16291](https://arxiv.org/abs/2305.16291)) **[paper, TMLR]**.
- **ReasoningBank** distils strategies from *self-judged successes **and** failures*, beating memory
  that stores raw trajectories or only successful routines
  ([arXiv:2509.25140](https://arxiv.org/abs/2509.25140)) **[paper, ICLR'26]**.
- **SICA** lets an agent edit its own scaffold: SWE-bench Verified **17% → 53%** on a random subset
  ([arXiv:2504.15228](https://arxiv.org/abs/2504.15228)) — **[preprint]**, one scaffold, self-reported.
- **Anthropic's long-running harness** is the industrial version: a progress file, a JSON feature list
  where only a `passes` flag may change, a commit per session, and end-to-end verification before
  marking anything done. **[shipped]**

**Fit.** PandaCode is unusually well placed. `docs/skills-library.md` already defines a Markdown bundle
with provenance, a content hash, per-harness activation and a `skills_matrix`; `turn_changes` knows
which turns changed files; `checks.rs` knows which passed. What is missing is the **gate**: nothing
connects "this trajectory succeeded and was verified" to "this skill deserves to exist". SICA-style
self-editing is out of scope — it would be a regression surface with no test coverage.

**Cost.** M. Rust for extraction and storage; TS for a review queue in the skills manager. Local and
cheap (a few calls per accepted candidate), and the write is a normal skill file the user can delete.

**Proposal — a playbook loop gated on verified outcomes.**
1. **Candidate extraction.** A scheduled job (existing `schedules.rs`) scans recent turns and selects
   trajectories that are *verified* (check passed, no test file edited) and *contrastive* (a sibling
   failure in the same project).
2. **Distillation.** One model call produces a candidate skill — trigger, steps, evidence (task IDs,
   check names). ACE's incremental sections, not one rewritten blob, avoid brevity bias.
3. **Failure taxonomy.** Failures are bucketed into a fixed small taxonomy (wrong file, missing
   verification, test tampering, scope creep, flaky dependency) and shown as a sidebar breakdown; it is
   what makes the queue reviewable.
4. **Human gate.** Nothing activates without a click, and activation uses `skills_activate`, so
   provenance, hashes and per-project scope already apply.

**Signal.** On a project with three related verified successes one candidate appears naming them;
accepting creates `<app data>/skills/<id>/SKILL.md` with the evidence block; rejecting writes nothing;
a unit test proves a candidate is never created from a turn that edited a test file.

## 9. Reward modelling from execution outcomes

**What.** Use the pass/fail of a real verifier as the reward, instead of a learned preference model.

**Evidence.** RLVR (named by Tülu 3) replaces a neural reward model with a programmatic verifier — a
test suite, a compiler, a DB assertion. It scales because tests can be built automatically, but the
literature flags two systematic problems: **faithfulness** (does the test measure the intent?) and
**reward hacking** (does the agent satisfy the test without solving the task?) — see note 03, which
cites ImpossibleBench's **76%** exploit rate on one-off impossible tasks **[preprint]**. AgentRewardBench
makes the same point for judges: none is reliable across domains, and one that never fails under-credits
silently.

**Fit.** PandaCode has a verifier (`checks.rs`) but no reward signal — no way to say "model A produced
verified outcomes 7/10 times here, model B 4/10". `model_health.rs` tracks *availability*, never
*quality*; `model_routing.rs` predicts `p_success` from a difficulty classifier, not from observed
outcomes.

**Cost.** S. SQL over `turn_changes` ⋈ check results; a column on an existing table in a new
`user_version` migration.

**Proposal.** Define a per-turn **reward**: `verified_pass = check ran, passed, and no test file in
turn_changes`. Aggregate per (project, harness, model) and show it in the Agent usage panel beside
cost. No learned reward model — a rate with a Wilson interval is enough and cannot be gamed by the
model under evaluation. Refuse to show a rate under n=10.

**Signal.** A project with 20 turns shows a per-model verified-pass rate with an interval; a turn that
edited a test file never counts as a pass (fixture test); rates under n=10 render "not enough data".

## 10. Regression suites for prompts and agent configuration

**What.** A frozen set of tasks that must keep passing when a prompt, model, effort or skill changes —
the "regression eval" half of Anthropic's capability/regression split, grown from real failures.

**Evidence.** Anthropic: start with **20–50** tasks drawn from real failures, keep regression suites
near 100%, and let saturated capability tasks graduate into regression duty. Qodo's case is the
cautionary one: one-shot evals showed nothing on Opus 4.5 until they built an agentic eval.
**[shipped]** GEPA's adversarial-search section shows how to make a suite *adversarial* rather than
flattering.

**Fit.** PandaCode has the ingredients: `recipes` for ordered multi-step flows, `checks.rs` for the
oracle, `turn_changes` for failure candidates, worktrees for isolation, teams for running candidates.
What it lacks is a **suite** — a named, versioned set of tasks with expected outcomes, re-runnable and
comparable with an interval.

**Cost.** M. A recipe-adjacent JSON format plus a runner in Rust; TS for the review surface. Local,
opt-in, and it spends real inference per run so it is a scheduled or manual action, never automatic.

**Proposal.** `.pandacode/evals/<name>.json` (mirroring the recipe format, so the loader and validation
patterns are reused): tasks with a prompt, a starting commit, and the check that must pass. "Run suite"
runs it in a scratch worktree, stores the result with the `(prompt pack, model, effort)` triple, and
compares against the previous run using the paired bootstrap from §5. Seed the first suite from the last
three *failed* `turn_changes` turns.

**Signal.** Running a suite twice unchanged reports "no clear change"; flipping one task's oracle to fail
produces a detected regression with a negative interval; results carry the config triple so a
cross-config comparison is refused.

## 11. Cost and latency as a first-class quality axis

**What.** Report quality per unit cost and per unit time, not quality alone.

**Evidence.** "AI Agents That Matter" is the canonical argument: accuracy-only reporting makes SOTA
agents "needlessly complex and costly" and leads the field to the wrong conclusion about *why* they
work; it proposes joint accuracy–cost optimisation **[paper]**. GEPA's prompts are ~33% shorter, a
downstream cost win as well as a quality win **[paper]**. `usage_ledger` already models the pricing
tiers (cache read/write, long-context) correctly.

**Fit.** PandaCode has the ledger but never joins it to quality. `TaskUsage` carries input, cache_read,
cache_write and output per harness session; `messages.turn_duration_ms` carries time. The Council has a
score and no cost, so "9.2/10 at 4× the tokens" is indistinguishable from "9.0/10".

**Cost.** S. Join two existing tables; add fields to one payload and one panel column.

**Proposal.** Compute **cost per verified task** and **tokens per Council point** per (project, model,
harness) from `usage_ledger` ⋈ `turn_changes` ⋈ checks, next to the rate from §9. Never render a
savings claim without the same interval discipline. This is also the honest answer to "is the expensive
model worth it": a paired comparison of two configs on the same tasks, reported as Δquality and Δcost.

**Signal.** The Agent usage panel shows a per-model table with verified-pass rate, median cost and cost
per verified task; a unit test proves unpriced models are excluded rather than counted as $0.

## 12. Ranked shortlist

| Rank | Upgrade | Confidence | Why first | Size |
|---|---|---|---|---|
| 1 | **Local eval harness over saved trajectories** with paired bootstrap and pass^k (§3, §5, §10) | **High** | No network, no new inference by default, and turns data PandaCode already owns into the only honest comparison it can make. Everything else depends on it. | M |
| 2 | **Council judge calibration**: rubric library, order swap, agreement (α), calibration set (§4) | **High** | Council already gates `finish_team`; an uncalibrated gate is an active liability. Cheapest fix to the highest-consequence surface. | M |
| 3 | **Playbook/skill loop gated on verified outcomes** with a failure taxonomy (§8) | **Medium-high** | ACE/Voyager/ReasoningBank converge on this design; the skill store, provenance and verifier already exist. Gating on verification stops it becoming a rumour mill. | M |
| 4 | **Per-project regression suite grown from past failures**, run in a worktree, compared by interval (§10) | **Medium-high** | Anthropic's 20–50-task guidance fits one developer's project; recipes + worktrees make it nearly free. | M |
| 5 | **Quality regression alerts in the sidebar** from verified-pass rate + cost per verified task (§9, §11) | **Medium** | High value, but trustworthy only *after* 1 and 2 exist; shipping it first is exactly the small-n noise §5 warns about. | S–M |

Not ranked: prompt reflection (§7) and replay evaluation (§6). Both are sound and become cheap *after*
the harness in rank 1 exists; alone they are expensive opinions.

## 13. Rejected, or already covered

**Already covered — upgrade, do not re-propose.** *Usage ledger / token accounting*
(`usage_ledger.rs` already does duplicate-reply suppression, cache-read/write splitting and long-context
tiers; §11 only adds a join) · *Council scoring with rounds and a target* (the mechanism exists; §4
fixes its statistics) · *Checks after a turn* (`checks.rs` + `turn-checks.ts` do plan → run → bounded
repair) · *Model health* (`model_health.rs` tracks availability; §9 adds quality, a different axis) ·
*Schedules for recurring runs* (`schedules.rs` has run outcomes and failure backoff; §3 and §10 reuse
it).

**Rejected, with reasons.**
- **Fine-tuning / GRPO / RLVR training.** PandaCode never trains weights and has no GPU story; the
  *idea* (verifiable rewards) survives as §9, the mechanism does not.
- **A learned reward model.** Needs labels and a training loop, and it is more hackable than a test
  suite. A Wilson-interval rate is strictly more honest here.
- **Full DSPy/MIPROv2 or GEPA orchestration.** Real gains (13%, 10%), but they need a metric pipeline,
  hundreds to thousands of rollouts and a Python dependency. Downgraded to reflection-only (§7).
- **Meta-Harness / SICA-style self-editing of PandaCode's own harness.** Impressive **[preprint]**, but
  it lets a model rewrite the code that gates it — unacceptable blast radius for a local-first app with
  no telemetry to catch the regression.
- **Live A/B or canary over user traffic.** No accounts, no telemetry, n≈1 per project; the offline
  equivalent is §6, itself opt-in because it spends money.
- **Shadow traffic to a second live model every turn.** Silent cost multiplication; replay is the
  bounded substitute.
- **Importing SWE-bench Verified, WebArena, OSWorld or GAIA.** Contaminated or environment-heavy, all
  network-dependent, none about the user's repository. Their *method* is adopted in §1, not the data.
- **A "quality dashboard" built only on LLM-judge scores.** Uncalibrated judges plus small n is
  confidence without evidence — the exact failure §4 and §5 exist to prevent.

## 14. What is speculative

- **SICA (17% → 53%)** — one scaffold, random subset, self-reported **[preprint]**. Directional only.
- **Meta-Harness (+7.7, +4.7, Terminal-Bench wins)** — recent, one group, heavy compute **[preprint]**.
  Interesting for the *idea* of trace-rich search, not for adoption.
- **ACE's +10.6%** — ICLR'26 with good ablations, but its tasks are AppWorld-shaped, not
  repository-shaped. Adopt the structure (incremental sections, no rewriting), not the number.
- **ReasoningBank's "failures teach as much as successes"** — two benchmark families in one paper;
  plausible and cheap to try, not independently replicated.

## Sources

**Benchmarks.** [Why we no longer evaluate SWE-bench Verified](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/) · [Introducing SWE-bench Verified](https://openai.com/index/introducing-swe-bench-verified/) · [SWE-Bench Pro](https://scale.com/blog/swe-bench-pro) · [Terminal-Bench 2.0](https://arxiv.org/abs/2601.11868) · [tbench.ai](https://www.tbench.ai/) · [τ-bench](https://arxiv.org/abs/2406.12045) · [τ²-bench](https://arxiv.org/abs/2506.07982) · [WebArena](https://arxiv.org/abs/2307.13854) · [OSWorld](https://arxiv.org/abs/2404.07972) · [GAIA](https://arxiv.org/abs/2311.12983)

**Evaluation practice.** [Demystifying evals for AI agents](https://www.anthropic.com/research/demystifying-evals-for-ai-agents) · [Effective harnesses for long-running agents](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents) · [Adding Error Bars to Evals](https://arxiv.org/abs/2411.00640) · [AI Agents That Matter](https://arxiv.org/abs/2407.01502) · [AgentRewardBench](https://arxiv.org/abs/2504.08942)

**Judges and reliability.** [Judging LLM-as-a-Judge](https://arxiv.org/abs/2306.05685) · [Judging the Judges](https://arxiv.org/abs/2406.07791) · [CALM](https://arxiv.org/abs/2410.02736) · [Length-Controlled AlpacaEval](https://arxiv.org/abs/2404.04475) · [PoLL](https://arxiv.org/abs/2404.18796) · [Krippendorff's alpha](https://www.appen.com/blog/krippendorffs-alpha) · [guide](https://casrai.org/guides/krippendorffs-alpha)

**Learning from experience.** [GEPA](https://arxiv.org/abs/2507.19457) · [MIPRO](https://arxiv.org/abs/2406.11695) · [Meta-Harness](https://arxiv.org/abs/2603.28052) · [ACE](https://arxiv.org/abs/2510.04618) · [Voyager](https://arxiv.org/abs/2305.16291) · [ReasoningBank](https://arxiv.org/abs/2509.25140) · [SICA](https://arxiv.org/abs/2504.15228) · [Reflexion](https://arxiv.org/abs/2303.11366) · [Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798)

**Rollout practice.** [LLM A/B testing framework](https://atlan.com/know/ab-testing-llm-applications/) · [Shadow traffic and canary](https://futureagi.com/blog/llm-eval-shadow-traffic-canary-2026/) · [OPE limits](https://pmc.ncbi.nlm.nih.gov/articles/PMC12700629/)
