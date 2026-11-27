# Agent orchestration and inference-time compute

What PandaCode's Team and Council could adopt, with external evidence for each technique and a
ranked shortlist. Scope: orchestration topology, verifier/selection machinery, test-time compute
allocation, and the concurrency semantics underneath them.

## Method

Web access was available; every technique carries a primary source (paper abstract or lab
engineering post) fetched for this survey, listed under [Sources](#sources). Numbers quoted from a
paper's body rather than its abstract are marked *(reported)*. Anything without a measured result, a
shipped feature, or a widely reproduced benchmark is flagged **speculative**. Maturity labels:
**research** (paper only), **shipping at X** (in a product), **mainstream** (standard across vendors).

## Baseline: what Team and Council already do

Most of the naive upgrade space is occupied already. **Team** is an orchestrator-worker topology: an
architect dispatches assignments with explicit file scopes, dependencies, follow-ups, replacements
with escalation, and one-level-deep sub-workers that park and resume — plus mailboxes, a notes
blackboard, checkpoints, a 20-minute silence watchdog, generation checks against stale callbacks and
a 3-attempt cap (`docs/architect-workers.md`). **Council** is independent read-only reviewers each
scoring `N/10` on one integer axis, gated on the **lowest** score (not the mean), fresh reviewers per
round, lenses fixed in round 1, ≤8 seats and ≤10 rounds, reviewers blind to prior scores and the
target. **Panda Router v4** already estimates difficulty 1–10 plus required skills from an ONNX
profiler and escalates through a ladder on failure.

The interesting work is therefore not "add multi-agent" but (a) the *measurement* inside Council, (b)
*selection* instead of single-shot escalation, (c) reviewing the *process* rather than the artefact,
and (d) making effort and fan-out follow the difficulty signal the router already computes.

---

## 1. Orchestrator-worker vs ReAct vs single loop

**What it is.** Three topologies. *Single loop* (ReAct-shaped): one model alternates reasoning and
tool calls until an exit condition; the trace is one continuous context. *Orchestrator-worker*: a
lead decomposes, fans out to subagents with their own contexts, and synthesises. *Planner/executor*:
a planning step produces an explicit, inspectable plan; a separate executor (or several) carries
steps out; the plan is the interface.

**Evidence.** ReAct (arXiv 2210.03629) beat imitation/RL baselines by **+34% absolute success on
ALFWorld and +10% on WebShop** with 1–2 in-context examples, and is the substrate of essentially
every coding harness — *mainstream*. Anthropic's agent guidance
([building effective agents](https://www.anthropic.com/research/building-effective-agents)) names
orchestrator-worker and evaluator-optimizer as the two patterns worth reaching for in coding, and
states the governing rule: add complexity *only* when it demonstrably improves outcomes —
*mainstream*. Anthropic's production research system reports orchestrator-worker beating a single
Opus 4 agent by **90.2%** on their internal research eval — *shipping at Anthropic* — while noting
the same paper's caveat that **"most coding tasks involve fewer truly parallelizable tasks than
research"**. Agentless (arXiv 2407.01489) is the counterweight: a fixed
localise→repair→validate pipeline with no agent loop hit **32.00% on SWE-bench Lite at $0.70**,
then the best open-source agent score — *research, widely cited*.

**Why it fits.** PandaCode is already orchestrator-worker, and the architect doubles as reviewer —
a hybrid of orchestrator and evaluator. The gap is the *plan*: the objective is stored as a note but
is not machine-checkable, so a reviewer cannot say the execution diverged from it. Agentless is the
argument for a cheaper fixed path on bug-fix-shaped tasks where fan-out buys nothing.

**Cost & complexity.** **S/M** in Rust (a struct on the team snapshot plus a planner turn), no network.

**Proposal.** Make the objective a first-class `Plan` on the team snapshot — ordered steps, each with
files and an acceptance check — written by the lead before the first dispatch, and refuse a writer
dispatch that no plan step covers. **Acceptance signal:** on the golden team fixtures, ≥90% of writer
assignments map to a plan step; a "plan diverged" refusal is reachable and covered by a test.

## 2. Supervisor/handoff vs swarm — and when multi-agent actually wins

**What it is.** *Supervisor* (manager): one agent holds the user-facing thread and invokes others as
tools. *Handoff* (decentralised): control transfers to a peer that then owns the conversation.
*Swarm*: many peers, no centre.

**Evidence.** OpenAI's [practical guide to building agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)
recommends maximising a single agent first, and gives two concrete triggers for splitting: prompts
with many conditionals, and **tool overload — overlap matters more than count** (some teams handle
15 distinct tools, others fail below 10 overlapping ones) — *mainstream*. Cognition's
[Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents) argues the opposite
default with a sharper claim: *actions carry implicit decisions*, so parallel agents that cannot see
each other's decisions produce mutually inconsistent work, and it cites Claude Code's subagents as
deliberately only *answering questions*, never writing code in parallel — *shipping at Cognition*.
MAST (arXiv 2503.13657) supplies the measured middle: across **1600+ traces in 7 frameworks**, the
14 failure modes cluster into system design, **inter-agent misalignment**, and **task verification**,
with "performance gains often minimal" on popular benchmarks — *research, κ=0.88 annotation*.

**Why it fits.** PandaCode already resolves Cognition's objection better than most: file scopes are
explicit, overlapping writers are serialised, and the notes blackboard plus mailboxes share decisions
— exactly the context-sharing Cognition says is required. What it lacks is the OpenAI trigger: no
structural test for *should this have been split at all*.

**Cost & complexity.** **S**, TypeScript/Rust, local.

**Proposal.** Add a `delegationJustification` requirement on `dispatch_workers` above a fan-out
threshold: the lead states either "genuinely parallel" (disjoint scopes, no shared decisions) or
"needs a different model". Refuse the batch otherwise with guidance to do it in one context.
**Acceptance signal:** teams with ≤2 concurrent writers show no more dispatch attempts per completed
task than today, measured on the replay fixtures.

## 3. Context isolation and subagent summarisation

**What it is.** Each subagent gets its own context window and returns a *compressed* result, so the
lead's context grows with conclusions rather than transcripts.

**Evidence.** Anthropic's research post names this as the core mechanism — subagents act as
"intelligent filters", and the appendix recommends **subagent output to a filesystem with lightweight
references** rather than copying large outputs through the lead ("the game of telephone") —
*shipping at Anthropic*. Chain-of-Agents (arXiv 2406.02818) measures the sequential variant: worker
agents each read a short segment and pass forward, a manager synthesises, **up to +10% over RAG and
full-context baselines** — *research*. Cognition concedes the same benefit while warning it needs a
*purpose-built* compressor and that they fine-tuned a small model for it — *shipping at Cognition*.

**Why it fits.** Already half-built: workers get assignment + scope, not the parent conversation, and
the lead reviews "bounded results". The weakness is that the artefact channel is the *checkout* only;
there is no cheap way for a worker to hand back a large structured result (a diff summary, a coverage
map, a failing-test list) without it passing through the lead's context.

**Cost & complexity.** **M**, Rust (a scoped artefact directory under the task, referenced by path).

**Proposal.** Let an assignment declare `artefacts: [...]` — paths outside the checkout that the
worker may write and the lead receives as references plus a bounded excerpt. **Acceptance signal:**
a test proving a 200 KiB result reaches the lead as <2 KiB of context with the path intact.

## 4. Best-of-N and parallel sampling with verifier selection

**What it is.** Sample K candidate solutions, then *select* rather than generate: a verifier, a test
suite, or a selection trajectory picks the winner.

**Evidence.** The strongest single result in this area. Large Language Monkeys (arXiv 2407.21787)
shows coverage scaling over **four orders of magnitude** of samples; on SWE-bench Lite,
DeepSeek-Coder-V2 goes **15.9% at 1 sample → 56% at 250**, beating the 43% single-sample SOTA —
*research, widely reproduced*. CodeMonkeys (arXiv 2501.14723) turns that into a working system:
K multi-turn trajectories, **selection by model-generated tests plus a dedicated selection
trajectory**, resolving **57.4% of SWE-bench Verified for ~$2300**, and — the important part for
PandaCode — selection over an *ensemble of edits from different existing submissions* scored
**66.2%, beating the best member of the ensemble**. Snell et al. (arXiv 2408.03314) show selection
efficiency is the frontier: compute-optimal allocation is **>4× more efficient than flat best-of-N**,
and in a FLOPs-matched comparison test-time compute **beats a 14× larger model** where the smaller
model has non-trivial success rates — *research*.

**Why it fits.** PandaCode already has the plumbing: disjoint scopes, N parallel writers, a lead that
verifies with tests/typecheck. What it does *not* have is the idea of spending K on the same
assignment and selecting. Today escalation is strictly sequential (`replaces` + ladder) — the
expensive model is the *fallback*, never a rival candidate.

**Cost & complexity.** **L**. Rust scheduler change (allow overlapping scopes in a "sample" group,
collect outcomes), plus a selection turn; K× inference cost, which is real money the user pays.

**Proposal.** A `sample: K` field on high-risk assignments: K writers run on the same scope in
sibling worktrees or on branches, then a selection step runs the acceptance check and, if more than
one passes, a read-only selector picks. Default off, gated on router difficulty ≥ 7 or a `risky`
flag. **Acceptance signal:** on a fixture repo with a seeded flaky fix, K=3 raises pass rate over K=1
at equal acceptance-check rigour, and the losing candidates leave no residue in the checkout.

## 5. Self-consistency

**What it is.** Sample multiple reasoning paths and take the majority answer.

**Evidence.** Self-consistency (arXiv 2203.11171) replaced greedy CoT decoding with sampled paths plus
majority vote, giving large gains on arithmetic and commonsense benchmarks *(reported: ≈+18 points on
GSM8K with PaLM-540B)* — *mainstream*, the default in most eval harnesses.

**Why it fits.** Poorly. Majority voting needs a *discrete answer*; two different correct patches
share no tokens. Where it fits is narrow but real: **verdict aggregation inside Council** (see the
shortlist), and classification-shaped sub-decisions such as "does this diff satisfy the plan step".

**Cost & complexity.** **S** to implement, K× tokens.

**Proposal.** Do not add self-consistency as a sampling strategy for code. Reuse the mechanism only as
*verdict aggregation*, which the Bradley-Terry proposal in the shortlist already does.

## 6. Process reward models, verifiers, critic models

**What it is.** A reward model scores *steps*, not just the final answer; dense process scores enable
better search and earlier stopping than sparse outcome scores.

**Evidence.** OpenAI's *Let's Verify Step by Step* (arXiv 2305.20050) showed process supervision
outperforming outcome supervision and majority voting when reranking MATH solutions, releasing
**PRM800K** (800k step-level human labels), with the best PRM reported at **78.2%** *(reported)* —
*research, heavily reproduced*. AgentPRM (arXiv 2502.10325) extends it to agents via Monte Carlo
rollout step rewards, and **3B models trained this way beat strong GPT-4o baselines on ALFWorld** —
*research*. Generative verifiers (arXiv 2408.15240) show a *generative* critic with chain-of-thought
beats discriminative and LLM-as-judge verifiers, lifting best-of-N from **5% → 45.3%** on algorithmic
tasks and **73% → 93.4%** on GSM8K — *research, ICLR 2025*.

**Why it fits.** PandaCode cannot train a PRM — no pipeline, and local-first forbids it. But the
*generative verifier* form is just a prompt: a critic reading a bounded trajectory and judging whether
each step was justified by its tool result. Directly implementable, and it maps onto MAST's "task
verification" failure category.

**Cost & complexity.** **M** for the prompted verifier (TypeScript prompt + Rust plumbing to expose a
bounded trace); **infeasible** for a trained PRM.

**Proposal.** Ship a *step-verifier prompt*, not a model: a read-only reviewer role that receives the
tool trace (command, exit code, first/last N lines of output) and answers per step "was this action
supported by the previous result?" with a verdict and a citation. **Acceptance signal:** on a seeded
trajectory fixture with a fabricated tool result, the verifier flags the fabrication and names the
step; on a clean trajectory it produces no flags.

## 7. Debate and adversarial review

**What it is.** Multiple instances propose answers and critique each other over rounds before
converging, rather than scoring independently.

**Evidence.** Multiagent Debate (arXiv 2305.14325) reports significant gains in mathematical and
strategic reasoning and reduced hallucination with black-box models and identical prompts —
*research, widely cited*. SWE-Search (arXiv 2410.20285) uses a **Discriminator agent that runs
multi-agent debate**, reporting **+23% relative on SWE-bench across five models** versus the same
agents without MCTS — *research*. Counterweight: Cognition argues agents cannot conduct long-context
proactive discourse more reliably than a single agent, and MAST's *inter-agent misalignment* category
is the empirical shadow of debate going wrong — *shipping at Cognition*.

**Why it fits.** Council is deliberately *independent* scoring — no cross-talk — which is the right
default for avoiding anchoring. The evidence says the cheap win is not full debate but **one
adversarial seat**: a reviewer whose lens is "find the defect that survives the others' reports".

**Cost & complexity.** **S/M**, Rust prompt change plus one extra seat per round.

**Proposal.** Add a reserved lens, `red-team`, that runs last in a round and receives the other seats'
findings plus the work, with a falsification mandate: confirm or refute each finding by inspecting
the artefact. Its output is adjudication, not another integer. **Acceptance signal:** over a fixture
set of seeded defects, the red-team seat converts ≥1 false-positive finding per round into a refuted
finding without dropping any true positive.

## 8. Tree search / MCTS-lite over trajectories

**What it is.** Explore several branches of a solution, evaluate, and backtrack — Tree of Thoughts
generalises CoT into search; MCTS adds a value function and visit counts.

**Evidence.** Tree of Thoughts (arXiv 2305.10601) lifted Game of 24 from **4% (CoT) to 74%** with
GPT-4 — *mainstream as a technique*. SWE-Search (2410.20285) applies MCTS to repository-level
software tasks with a hybrid numeric/qualitative value function, **+23% relative** over standard
agents — *research*. Both are expensive: ToT needs many model calls per node.

**Why it fits.** Weakly. This is the highest-cost technique here: PandaCode's analogue of a node is a
*worker process with a checkout*, not a token sequence, so branching means worktrees and real time.
The one cheap subset is **retry-with-a-different-approach**: instead of only escalating model strength
on `replaces`, tell the replacement what was tried and instruct it to take a materially different
approach.

**Cost & complexity.** **L** for real search; **S** for the retry variant.

**Proposal.** Do not build MCTS. Add `replaces` guidance that carries the failed approach's summary
so the replacement branches rather than repeats. **Acceptance signal:** replacement pass rate on
seeded-failure fixtures improves versus today's `replaceReason`-only escalation.

## 9. Speculative and cascade execution

**What it is.** *Cascade*: try a cheap model, verify, escalate only on failure. *Speculative*:
a fast model drafts, a slow model verifies/corrects, accepting the draft when it agrees.

**Evidence.** FrugalGPT (arXiv 2305.05176) matches the best single model (GPT-4) with **up to 98%
cost reduction**, or **+4% accuracy at equal cost**, via a learned cascade — *research, shipped as
the idea behind most routers*. Speculative decoding (arXiv 2211.17192) gives **2–3× latency
improvement with identical output distribution** — *mainstream in inference engines, but at the
token level*. Anthropic's post and PandaCode's own model-routing doc both already describe cascades.

**Why it fits.** **The cascade is already implemented** — Router v4's ladder *is* FrugalGPT-shaped, with
a success head and a never-step-down floor. The token-level trick does not apply: PandaCode does not
own the sampler, the harness does. Agent-level speculation is the only open ground and it is
**speculative**: no credible published result exists for a cheap agent drafting a patch that a
stronger agent verifies, because verifying a whole patch costs as much as generating it.

**Cost & complexity.** **L** and unproven.

**Proposal.** Do not build it. Note in the routing doc that the ladder is the cascade and that agent
speculation is unmeasured.

## 10. Reflection and self-repair loops

**What it is.** The agent critiques its own output and revises, optionally over several rounds, with
or without a stored lesson.

**Evidence.** This is where the literature is most divided, and the split is the useful finding.
Self-Refine (arXiv 2303.17651) reports **~20% absolute average improvement across 7 tasks** with
GPT-3.5/ChatGPT/GPT-4 using no training — *mainstream*. Reflexion (arXiv 2303.11366) adds an episodic
memory of verbal lessons and reports **91% pass@1 on HumanEval vs 80% for GPT-4** — *widely cited*.
But *Large Language Models Cannot Self-Correct Reasoning Yet* (arXiv 2310.01798, ICLR 2024) shows
that **without external feedback, intrinsic self-correction fails on reasoning and can make
performance worse** — *research, and the finding that has held up*.

**Why it fits.** The reconciliation is the actionable rule: self-repair works when the feedback is
*external* — a failing test, a type error, a compiler message, a reviewer's cited defect — and is
unreliable when the model grades itself. PandaCode already has the external signals and, critically,
the Council gate.

**Cost & complexity.** **S**, mostly prompt discipline.

**Proposal.** Make the rule explicit in worker and reviewer rules: a self-repair round must cite an
external signal (command + exit code, or a named finding), and a repair attempt with no external
signal counts as a failure for attempt accounting. **Acceptance signal:** worker transcripts show no
repair loops without a cited signal on the fixture set; the 3-attempt cap is reached less often on
seeded-failure fixtures.

## 11. Effort control and thinking budgets as a routing axis

**What it is.** Per-request control over how much the model thinks before answering — a token budget
or a discrete level.

**Evidence.** Anthropic's thinking docs make the mechanics concrete: `budget_tokens` (min 1024, must
be below `max_tokens`), now superseded by **adaptive thinking plus discrete `effort` levels**, with
**interleaved thinking** letting the model reason between tool calls — *shipping at Anthropic*.
s1 (arXiv 2501.19393) shows budget *forcing* — truncating thinking, or appending "Wait" to extend it
— moves AIME24 from **50% → 57%** and beats o1-preview by up to 27% on competition math — *research
with an open recipe*. Snell et al. (2408.03314) is the routing argument: **compute-optimal allocation
by prompt difficulty beats uniform allocation by >4×**.

**Why it fits.** PandaCode already routes *model* by difficulty and lets an assignment set
`reasoningEffort` — but the two decisions are independent, and effort defaults to the lead's or the
profile's. Router v4 computes difficulty 1–10 on every dispatch and throws that signal away for
effort. That is a free, principled coupling.

**Cost & complexity.** **S/M**, Rust (`routing::staff` already sees the profile and the difficulty),
no network.

**Proposal.** Derive a default effort from router difficulty (e.g. ≤3 → `low`, 4–6 → `medium`, ≥7 →
`high`) and fit it to the model's catalog exactly as `model_efforts.rs` already does, with an explicit
`reasoningEffort` still overriding. Also surface the Anthropic cost note: **changing the budget
invalidates prompt cache**, so hold effort stable within a worker's conversation. **Acceptance
signal:** on the routing replay fixtures, median effort falls for easy assignments and rises for hard
ones versus today's constants, with no change in explicit-effort behaviour.

## 12. Interleaved thinking and tool-result reasoning

**What it is.** The model reasons *after* each tool result rather than only once at the turn's start,
so it can revise on evidence.

**Evidence.** Anthropic's interleaved thinking (docs above) is the shipped form; their research post
says subagents "plan, then use interleaved thinking after tool results to evaluate quality, identify
gaps, and refine their next query", and that extended thinking improved instruction following and
efficiency — *shipping at Anthropic*. ReAct (2210.03629) is the pre-LLM-native statement of the same
principle — *mainstream*.

**Why it fits.** PandaCode does not control this: it is a property of the harness and model. What it
*can* control is whether the worker prompt asks for post-tool reflection explicitly, and whether the
recorded trace preserves enough of the tool result for a reviewer to judge the reasoning.

**Cost & complexity.** **S**, prompt + trace retention.

**Proposal.** Worker rules require one sentence of post-tool reasoning before the next action when a
tool fails or returns something unexpected; and the trace retained for review keeps exit codes plus a
bounded output excerpt. **Acceptance signal:** the step verifier (technique 6) can always cite a tool
result for a flagged step — i.e. no flag without an available citation.

## 13. Concurrency and cancellation semantics

**What it is.** What happens when K agents run at once and something is cancelled: does a late
callback mutate state, does a cancelled worker write, does a paused team's in-flight run resume?

**Evidence.** Anthropic's post names synchronous execution as a **bottleneck** — the lead waits for a
whole batch, cannot steer, and one slow subagent blocks everything — and says asynchronicity adds
"result coordination, state consistency, and error propagation" problems that they have not yet
solved — *shipping at Anthropic, unsolved*. MAST's *system design* category contains the resulting
failure modes, including premature termination — *research*.

**Why it fits.** This is PandaCode's strongest area and should be protected, not rewritten.
Generation checks, pause/stop/resume without burning attempts, parking, the 30-second settle tick and
the silence watchdog are collectively ahead of what the labs describe. The gap is that they are
*documented* rather than *specified as invariants with tests*.

**Cost & complexity.** **S**, tests only.

**Proposal.** Promote five invariants to named tests: (1) no callback from a superseded generation
mutates a worker; (2) a cancelled worker's late result never marks the assignment complete; (3) a
paused team's in-flight run cannot start new work; (4) cancellation of a parent stops its children;
(5) a resume never double-spends an attempt. **Acceptance signal:** all five exist and fail when the
corresponding check is reverted.

---

## Ranked shortlist

| # | Upgrade | Confidence | Cost | Why it ranks here |
|---|---------|-----------|------|-------------------|
| 1 | Council: rubric dimensions + pairwise comparison + Bradley-Terry aggregation, replacing the single-integer lowest-score veto | **High** | M | Attacks a measured defect (see below); no new inference per round beyond one pairwise pass; pure Rust + prompt |
| 2 | Process-level review: reviewers receive a bounded tool trace and must cite it | **High** | M | Direct hit on MAST's third failure category; makes "verify by inspecting" enforceable rather than aspirational |
| 3 | Verifier-selected best-of-N for high-risk edits (`sample: K`) | **Medium-high** | L | Strongest measured effect in the survey (CodeMonkeys, Monkeys, Snell); gated so cost is opt-in |
| 4 | Router difficulty drives effort *and* fan-out budget | **Medium** | S/M | Signal already computed and currently discarded; one change, two dials |
| 5 | Red-team seat in Council with a falsification mandate | **Medium** | S | Cheap; converts the independent-scoring design into adjudication without full debate |

**Why #1 first.** Council currently takes a single integer per reviewer and gates on the **lowest**
score. Three measured problems compound there:

- **Unanchored scale.** LLM-as-judge work (arXiv 2306.05685) shows strong judges reach **>80%
  agreement with humans** — but also documents position, verbosity and self-enhancement biases. A
  bare `7/10` gives the gate nothing to check; a rubric with per-dimension verdicts does.
- **Veto power.** A lowest-score gate lets one strict reviewer block a cycle that every other
  reviewer passed, and there is no evidence the lowest score is the right statistic. Chatbot Arena
  (arXiv 2403.04132) ranks on **pairwise comparisons aggregated with Bradley-Terry**, which is
  robust to individual scale differences precisely because it never compares raw integers.
- **Round-to-round incomparability.** Fresh reviewers per round is right for avoiding anchoring, but
  it means round 3's `8` and round 1's `8` are not the same measurement. Pairwise comparison *of two
  candidate work states* by the same seat is comparable; integers across seats and rounds are not.

Concrete shape: keep the integer (users like it, and the UI, `parse_score`, the nudge and the gate all
depend on it) but add, per reviewer, a fixed small rubric — correctness / completeness / fit-to-goal,
each `pass|fail|n-a` with a required citation — and, in rounds ≥2, one pairwise question: "is work
state B better than A for your lens, worse, or indistinguishable?" with A/B order randomised per
seat. Aggregate pairwise verdicts with Bradley-Terry into a per-lens score; the gate then requires the
BT-derived lower bound to clear the target **and** no failing rubric dimension. That keeps the
existing gate semantics while removing the single-integer veto.

**Why #4 is cheap and should not be skipped.** `routing::staff` already has difficulty in hand at
dispatch time. Coupling it to `model_efforts.rs`'s existing fitting logic is a small change with a
clear replay test, and it is the only proposal here that reduces cost rather than raising it.

## Rejected or already covered

- **Multi-agent as an addition.** Already the core of Team. Adding a swarm or handoff topology on top
  would add MAST's inter-agent misalignment risk with no measured benefit for coding-shaped work;
  Cognition's objection stands.
- **Self-consistency as a sampling strategy for code.** No discrete answer to vote on. Reused only as
  verdict aggregation inside #1.
- **Trained PRM / reward model.** No training pipeline, and it breaks local-first (a scoring model
  needs weights or a network call). The prompted generative verifier is the portable substitute.
- **Full MCTS over trajectories.** Correct in principle (SWE-Search), but each node is a process and a
  checkout. Replaced by the cheap retry-with-a-different-approach subset.
- **Agent-level speculative execution.** **Speculative**; no credible published result, and patch
  verification costs as much as patch generation. Token-level speculative decoding lives in the harness.
- **Debate as the primary review mechanism.** Independence is the right default; only the red-team
  seat (ranked #5) is justified.
- **Reflection without external feedback.** Actively harmful per arXiv 2310.01798; only
  signal-grounded repair is admitted (technique 10).
- **Planner/executor as a separate agent.** Partly covered: the lead plans, workers execute, file
  scopes are the interface. Technique 1's plan artefact is the cheaper 80%; a second planning *model*
  would add a turn without evidence it beats a well-structured prompt.
- **Fan-out as a quality lever.** Anthropic reports early agents **spawning 50 subagents for simple
  queries** as a failure mode, fixed with explicit effort-scaling rules — evidence for *refusing*
  over-delegation, not for more parallel agents.
- **Already shipped, do not re-propose:** escalation ladders and failover (Router v4 + model health),
  per-assignment effort overrides and catalog fitting (`model_efforts.rs`), worker parking and
  one-level sub-workers, the shared notes blackboard and mailboxes, the 20-minute silence watchdog,
  and the generation checks. Technique 13 proposes tests for the last of these, not new behaviour.

## Sources

- Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/research/multi-agent-research-system) — orchestrator-worker, 90.2% gain, 15× tokens, 4× for agents, token usage explains 80% of BrowseComp variance, synchronous bottleneck, subagent-to-filesystem.
- Anthropic, [Building effective agents](https://www.anthropic.com/research/building-effective-agents) — workflow vs agent, orchestrator-workers, evaluator-optimizer, sectioning vs voting, "add complexity only when it demonstrably improves outcomes".
- Anthropic, [Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) and [Effort](https://platform.claude.com/docs/en/build-with-claude/effort) — `budget_tokens` rules, adaptive thinking, interleaved thinking, cache invalidation on budget change.
- OpenAI, [A practical guide to building agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf) — single-agent first, manager vs decentralised, split triggers (complex logic, tool overload), guardrails, human intervention.
- Cognition (Walden Yan), [Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents) — share full traces, actions carry implicit decisions, Claude Code subagents as question-answerers.
- Cemri et al., [Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657) — MAST, 1600+ traces, 14 modes / 3 categories, κ=0.88.
- Yao et al., [ReAct](https://arxiv.org/abs/2210.03629) — +34% ALFWorld, +10% WebShop.
- Xia et al., [Agentless](https://arxiv.org/abs/2407.01489) — 32.00% SWE-bench Lite at $0.70, no agent loop.
- Brown et al., [Large Language Monkeys](https://arxiv.org/abs/2407.21787) — coverage over 4 orders of magnitude; 15.9% → 56% on SWE-bench Lite. Ehrlich et al., [CodeMonkeys](https://arxiv.org/abs/2501.14723) — 57.4% SWE-bench Verified; test-based + trajectory selection; 66.2% ensemble selection.
- Snell et al., [Scaling test-time compute optimally](https://arxiv.org/abs/2408.03314) — >4× over best-of-N; beats a 14× larger model FLOPs-matched.
- Wang et al., [Self-Consistency](https://arxiv.org/abs/2203.11171). Lightman et al., [Let's Verify Step by Step](https://arxiv.org/abs/2305.20050) — process supervision, PRM800K.
- Choudhury, [Process Reward Models for LLM Agents](https://arxiv.org/abs/2502.10325) — AgentPRM/InversePRM, 3B beats GPT-4o on ALFWorld. Zhang et al., [Generative Verifiers](https://arxiv.org/abs/2408.15240) — GenRM, 5%→45.3% algorithmic, 73%→93.4% GSM8K. Du et al., [Multiagent Debate](https://arxiv.org/abs/2305.14325).
- Antoniades et al., [SWE-Search](https://arxiv.org/abs/2410.20285) — MCTS + debate discriminator, +23% relative. Yao et al., [Tree of Thoughts](https://arxiv.org/abs/2305.10601) — Game of 24, 4% → 74%.
- Chen et al., [FrugalGPT](https://arxiv.org/abs/2305.05176) — cascade, up to 98% cost reduction or +4% accuracy. Leviathan et al., [Speculative Decoding](https://arxiv.org/abs/2211.17192) — 2–3×, identical outputs. Madaan et al., [Self-Refine](https://arxiv.org/abs/2303.17651) — ~20% absolute average across 7 tasks. Shinn et al., [Reflexion](https://arxiv.org/abs/2303.11366) — 91% pass@1 HumanEval.
- Huang et al., [LLMs Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798) — intrinsic self-correction fails; can degrade. Muennighoff et al., [s1](https://arxiv.org/abs/2501.19393) — budget forcing, 50%→57% AIME24.
- Zhang et al., [Chain of Agents](https://arxiv.org/abs/2406.02818) — up to +10% over RAG/full-context. Zheng et al., [Judging LLM-as-a-Judge](https://arxiv.org/abs/2306.05685) — >80% human agreement; position, verbosity, self-enhancement biases.
- Chiang et al., [Chatbot Arena](https://arxiv.org/abs/2403.04132) — pairwise comparison + Bradley-Terry ranking.
