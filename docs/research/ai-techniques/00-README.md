# AI techniques for PandaCode — synthesis and roadmap

Synthesis of the seven reports in this directory. It invents nothing: every row traces to a numbered
item in one of them, every claim to a section. Written 2026-11-27.

## Constraints that decide the ranking

| Constraint | Consequence |
| --- | --- |
| **Local-first** — no accounts, telemetry, phone-home or resident server; Rust core + one WebView + SQLite (AGENTS.md) | No hosted router, vector-DB server, traffic A/B, shadow traffic or training pipeline. Measure from SQLite the machine already owns. |
| **PandaCode does not own the agent loop** — agents are installed CLI/ACP harnesses (01 §Method, 04 §Method) | Out: constrained decoding at the API boundary, thinking-token control inside a turn, a resident memory service, CaMeL's interpreter. In: the dispatch, tool-host and prompt-assembly boundaries. |
| **n ≈ 1 per project, on a laptop** — no GPU, one user watching one run (06 §0) | Anything needing a training pipeline, GPU or large samples is suspect. Probe-based acceptance over population statistics; say "no clear change" rather than a noisy delta. |

## 1. How to read this series

Each report is self-contained: a baseline of the relevant surfaces, numbered techniques with primary
sources and an acceptance signal, a ranked shortlist, and a rejected/covered list. Read the report for an
area before changing it; read this file to choose what to do. The shortlists are merged in §3; the
rejected lists in §7.

| Doc | Scope | Top recommendation |
| --- | --- | --- |
| [01](01-agent-orchestration.md) | Team topology, Council selection, test-time compute, concurrency | Council rubric + pairwise/Bradley-Terry (#1) |
| [02](02-context-and-memory.md) | Cache layout, compaction, memory, repo context | Cache-aware assembly replacing the one-blob handoff (#1) |
| [03](03-verification-reliability.md) | Checks, test integrity, mutation, approvals, judge calibration | Verification ladder at the finish gate (#1) |
| [04](04-model-layer-efficiency.md) | Routing, effort, caching, structured output, protocols | Outcome ledger + replay, then bounded bandit (#1) |
| [05](05-interfaces-and-modalities.md) | Browser/VM grounding, visual diff, generative UI, voice | Element refs + stale-ref error + annotated capture (#1) |
| [06](06-evals-and-learning.md) | Offline evals, judge statistics, skill learning, cost | Local eval harness over saved trajectories (#1) |
| [07](07-agent-security.md) | Injection, capability scoping, secrets, egress, audit | Provenance envelope + taint sink check (#1) |

## 2. The convergent finding — and where the reports disagree

**Three independent reports converge on one conclusion: Council's gate consumes an unmeasured number.**
01 (shortlist #1) reaches it from selection literature (Chatbot Arena's pairwise Bradley-Terry vs a bare
integer), 03 (§10) from judge calibration (MT-Bench: >80% human agreement only once order is swapped and
a rubric exists; JudgeBench: near-random on hard diffs), and 06 (§4) from eval statistics (Krippendorff's
α; "no rubric, no order swap, no agreement statistic"). All three prescribe the same three inputs: **a
fixed rubric with per-dimension anchors, a required citation, and order-swapped pairwise comparison per
seat.** That triple is the headline recommendation — three literatures arrived at it separately, and it
fixes a surface that already gates `finish_team`.

**The reports do not fully agree on the aggregation rule, and the brief overstates the convergence.** 01
writes "replacing the single-integer lowest-score veto … the gate then requires the BT-derived lower
bound to clear the target". 03 §10 calls the lowest score "correct — averaging hides a blocker" and §16
says "Averaging Council scores — already correctly rejected … Keep it." 06 keeps the lowest but adds α
so a round with a wide spread "stops calling the lowest score authoritative." *I take 06's synthesis:*
keep the lowest as a **safety floor** (03 is right that a mean hides one blocker), make every score
**rubric-derived and evidence-backed** (01 and 03 are right that a freehand integer is not a
measurement), and let **α decide whether the low score is authoritative or one biased seat**. Union, not
a vote for any one doc.

**Other genuine disagreements, and the side I take:**

- **(a) Embeddings for code.** 02 ranks embeddings/rerankers *below* its shortlist (§G) and wants BM25 +
  PageRank first (02 #3); 04 ranks hybrid lexical+embedding search #5. *Sequence, not conflict:* 02 §F
  says "Add embeddings only after BM25 + PageRank has been measured", and 04's acceptance test drops the
  reranker unless nDCG@10 beats lexical-only by ≥10%. Take 02's order — index (row 21) first, embeddings
  gated on a measured baseline (row 33). They rank the *whole hybrid system* differently only because
  `ort` already ships.
- **(b) Set-of-mark.** 05 §14 downgrades SoM to opt-in while §1 fact 3 favours refs. *Consistent:* §1
  also reports OSWorld's finding that SoM and a11y trees are model-dependent and can *mislead*, and that
  refs "survive layout shifts". Refs default + annotated capture opt-in is exactly the evidence.
- **(c) Best-of-N.** The brief says 01 "rejects best-of-N as too costly"; **01 does not** — it ranks
  `sample: K` #3 (Medium-high / L), gated on difficulty ≥7 or a `risky` flag. It rejects
  *self-consistency* and *agent-level speculation*. Reconcile by risk tier: K is worth it only where the
  verifier can select among candidates, so 03's integrity work and the ladder must land first; ship row
  34 default-off.

The table ranks **value density** (evidence × payoff ÷ cost); the headline ranks **confidence in a shared
root cause**. They point at the same first month of work.

## 3. Master table — the merged shortlists

Ordered by (evidence strength × user-visible payoff) ÷ cost; adjacent rows are interchangeable. `S/M/L`
is engineering cost from the source doc. Conf is the source shortlist's grade, raised one notch only
where two docs independently agree (†).

| # | Upgrade | Source | Conf | Cost | PandaCode surface | Evidence |
|---|---------|--------|------|------|-------------------|----------|
| 1 | Test-integrity guard: oracle-vs-source split, `checked`≠`verified`, approval for oracle edits | 03 #2 | High | S | `checks.rs`, `turn-checks.ts`, `worker_approvals.rs` | ImpossibleBench: GPT-5 exploits 76% of impossible tasks; oracle edits are invisible. |
| 2 | Credential-path class + redaction pass (first rung of 07 #3) | 07 #3 | High | S | `shell-intent-risk.ts`, bot guard, transcript | Full-access workers read `~/.ssh`, `~/.aws`, `.env`; nothing redacts output. |
| 3 | Council: rubric + evidence-required scores + order-blind pairwise + α (keep lowest as floor) | 01 #1, 03 #5, 06 #2† | High | M | `architect/council.rs`, `src/council.ts` | Three literatures demand rubric/evidence/pairwise; MT-Bench bias is systematic. |
| 4 | Verification ladder at the finish gate (typecheck→lint→diff rules→tests→targeted, baseline-differentiated) | 03 #1 | High | M | `checks.rs::plan`, `turn-checks.ts`, `finish_team` | Reflexion 91% vs 80%; CYCLE +63.5%; checks skip teams and never escalate. |
| 5 | Browser refs, stale-ref error, annotated `capture_browser` | 05 #1 | High | M | `browser_agent.js`, `browser.rs`, `agent_tools.rs` | OSWorld: >75% of desktop failures are click mis-grounding; vendors converge on refs. |
| 6 | Provenance envelope + taint sink check on tool results | 07 #1 | High | M | tool host, `agent_tools.rs`, transcript | Spotlighting cuts indirect-injection ASR >50%→<2%; fixes the trust inversion. |
| 7 | Cache-aware prompt assembly + prefix-rewrite report | 02 #1 | High | S/M | `context_recovery.rs`, `usage_ledger` | OpenAI's agent example: >90% cache hit; today's one-blob handoff is a guaranteed miss. |
| 8 | Per-worker capability envelope (read/write/exec/network/tools) | 07 #2 | High | M | dispatch, tool host, `shell-intent-risk.ts` | OWASP LLM06/ASI02/ASI03 unanimous; scopes are advisory today. |
| 9 | Team `Plan` artefact + delegation-justification gate | 01 §1, §2 | Med-high | S/M | team snapshot, `dispatch_workers` | Agentless 32% at $0.70 on a fixed plan; over-delegation is unrefused. |
| 10 | Risk-tiered approvals + blast-radius preview + per-run prompt budget | 03 #4, 07 #4, 05 #4 | Med-high | S/M | `worker_approvals.rs`, `shell-intent-risk.ts`, approvals UI | 93% of prompts approved; attention is spent uniformly today. |
| 11 | **Effort chosen from difficulty and mode** (the first PR) | 01 #4, 04 #3† | Med-high | S/M | `architect/routing.rs::staff`, `model_efforts.rs` | Difficulty computed then discarded; fitting/override/note plumbing exists. |
| 12 | Canonical worker-report normalisation (schema + one repair) | 04 #4 | Med | S/M | worker reports, board, ledger | Harnesses won't honour schemas; one validate+repair makes the board reliable. |
| 13 | Red-team seat with falsification mandate | 01 #5 | Med | S | `architect/council.rs` | Independent scoring yields no adjudication; refutes false positives. |
| 14 | Observation contract: post-action capture + changed-region diff + dedupe | 05 #2 | High | S/M | `capture_browser`, Jev, `progress-pip.ts` | Judge +27% relative; screenshots cost ~1–1.8k tokens and are re-sent identical. |
| 15 | Retry-with-a-different-approach carried on `replaces` | 01 §8 | Med | S | `architect` replaces | MCTS is too costly; a failure summary is the cheap branch. |
| 16 | Parse-validate every edited source file after a turn | 03 §7 | Med | S | `turn_changes` validation | Truncated anchors caught before tests; 59% vs 26% edit-format evidence. |
| 17 | Jittered shared backoff + a single retry point | 04 §10 | Med-high | S | `model_health.rs`, scheduler | AWS: retries amplify overload; per-worker clocks collide. |
| 18 | Interface intent preview for consequential actions | 05 #4 | Med | S/M | browser/Jev path, `ask_user` card | Vendor guidance gates consent actions before *each* action; prose only today. |
| 19 | Process-level review over a bounded tool trace | 01 #2 | High | M | Council packet, trace retention | Direct hit on MAST's "task verification" category. |
| 20 | Structured state block for compaction | 02 #2 | Med-high | M | `context_recovery.rs`, `turn_changes`, checkpoints | +29%/+39%, −84% tokens; "compaction alone is not enough". |
| 21 | Local code index: tree-sitter symbols + FTS5 BM25 + file PageRank, one `search_code` | 02 #3 | Med-high | M | `workspace/text_search.rs`, `file_search.rs`, SQLite | aider's repo map is the best shipped cost/benefit; no symbol query today. |
| 22 | Outcome ledger + offline replay (bandit later) | 04 #1 | High | M | `panda_router/`, `usage_ledger`, schema 38 | The frozen head is the binding constraint; counterfactual logging stays local. |
| 23 | Local eval harness over saved trajectories (paired bootstrap, pass^k) | 06 #1 | High | M | `messages`, `turn_changes`, checks, worktrees | The only honest comparison offline; n≈1 forbids traffic tests. |
| 24 | Concurrency invariants promoted to named tests | 01 §13 | Med-high | S | architect worker state | Strongest area is documented, not specified. |
| 25 | Visual diff on design canvas + progress snapshots | 05 #3 | Med-high | S/M | `design-canvas.ts`, `progress-pip.ts` | Ingredients exist; region math is deterministic and needs no model. |
| 26 | Memory write policy: dedupe, decay, supersede-on-contradiction, provenance | 02 #4 | Med | S/M | `pandacode_team_notes`, checkpoints, migration | Notes never decay; contradictions overwrite silently. |
| 27 | Mutation-graded new tests | 03 #3 | Med-high | M | `checks.rs` + per-language adapters | Meta ACH 73% acceptance; vacuous green is invisible today. |
| 28 | Cache-aware fan-out: group by prefix, warm one, release the rest | 04 #2 | Med-high | M | `architect` scheduler | N identical prefixes = N writes; first-party warm-then-fan rule. |
| 29 | Quality alerts from verified-pass rate + cost per verified task | 06 #5 | Med | S/M | `usage_ledger`, Agent usage panel | Quality is never joined to cost; needs rows 22–23 first. |
| 30 | Skill injection for `prompt`-surface harnesses (stage 1) | 02 #5 | Med | M | `skills_matrix`, `skills/adapter.rs` | Skills are never injected for prompt-surface harnesses. |
| 31 | Playbook/skill loop gated on verified outcomes + failure taxonomy | 06 #3, 02 #5 | Med-high | M | skills library, `schedules.rs` | ACE +10.6%, Voyager transfer; store and verifier already exist. |
| 32 | Per-project regression suite grown from past failures | 06 #4 | Med-high | M | recipes, checks, worktrees | The 20–50-task guidance fits one project; recipes make it cheap. |
| 33 | Hybrid lexical + local embedding/rerank on the code index | 04 #5, 02 §G | Med | M | code index + `ort`/fastembed | Reranker closes 49%→67% of retrieval failures — after BM25 is measured. |
| 34 | Verifier-selected best-of-N (`sample: K`, default off) | 01 #3 | Med-high | L | scheduler, worktrees, selector | Strongest measured effect (15.9%→56%), but K× spend needs a trustworthy oracle. |
| 35 | Definition ledger (MCP/skill hashing) + one chained audit log | 07 #5 | Med | S/M | MCP bridge, `skills/safety.rs`, `bot_activity`, new table | Rug-pull and skill drift are invisible after install. |
| 36 | Declared component schema for generative UI with required text alternatives | 05 #5 | Med | M | `generative-ui.ts`, design tokens | 55.8% of 1,296 generated components carried a deceptive pattern. |

## 4. Four delivery waves

A wave ships only what the previous wave's evidence can judge.

### Wave 1 — zero new infrastructure, high confidence, S/M
**Ships:** rows 1, 3, 4, 5, 7, 9, 10, 11, 12, 14, 16, 17, 18, 19, 24. No migration, model download, new
process or network call.

**Acceptance:** a seeded type error is caught at rung 1 and the test failure is never named; a tampered
test renders `checked` naming the file; a hard assignment opens at `high` and an easy one at `low`; a
browser flow resolves every ref on first click and a stale ref returns the exact error; a Council round
with a 4-point spread renders α and refuses to call the low score authoritative; the ledger's cache-read
share rises on switched/resumed threads.

**Evidence:** none beyond today's baselines — this wave *produces* the labels, traces and dispatch notes
that Waves 2–3 consume. Start with row 11 (§8).

### Wave 2 — one new subsystem each
**Ships:** rows 6 and 8 (one boundary: the tool host), 20, 21, 22, 23, 25, 26, 27, 28, 30.

**Acceptance:** the index's top-5 holds the true definition for ≥80% of 50 "where is X" questions with
build <60 s; the eval harness reports "no clear change" unchanged and a negative interval for a flipped
oracle; an injected web string cannot cross threads in one turn; an out-of-envelope write is refused
naming the path; a reversed decision is answered correctly in ≥9/10 probes.

**Evidence from Wave 1:** the eval harness needs the `checked`/`verified` labels (1) to seed honest
suites; the envelope (8) needs row 10's severity classifier; provenance (6) needs row 1's oracle
classification; skill injection (30) needs stable briefs (12); fan-out (28) needs row 7's read share.

### Wave 3 — needs Wave 1/2 evidence first
**Ships:** rows 29, 31, 32, 33, 34, the online half of 22 (bounded bandit), and full blast-radius
approvals from row 10.

**Acceptance:** replay over ≥200 outcomes improves Brier by a pre-registered margin without raising
escalation; the regression suite detects a planted regression and refuses cross-config comparison; a
candidate skill is never created from a test-editing turn; K=3 raises pass rate where the oracle is
trustworthy and losers leave no residue.

**Evidence needed:** row 22's replay rows and row 23's harness for calibration; row 1's labels for the
skill gate; row 21's measured BM25 baseline before row 33; row 4's ladder and row 10's tiers before row
34 can select.

### Wave 4 — explicitly deferred, with reasons
| Deferred | Why |
| --- | --- |
| Full egress proxy, local-VM default for workers, per-device envelopes (07 §3, §6, §10) | Classifier and honesty label ship in Wave 1–2; the proxy/VM/per-device work is a subsystem whose benefit is unmeasured. |
| Speech-to-speech/barge-in, local document layout model, A2A client (05 §7, §4; 04 §8) | Different product, ~1 GB download, or no user demand — measure the cheap half first. |
| MCTS, agent-level speculation (01 §8, §9) | Every node is a process and a checkout; no credible agent-level result. |
| DSPy/GEPA search, Meta-Harness/SICA self-editing, fine-tuning/RLVR (06 §7, §13) | Metric pipeline, Python dependency, or a model rewriting the code that gates it. |

## 5. New feature vs enhancement

**(a) Enhancements to existing surfaces.** Team: rows 9, 15, 19, 24. Council: 3, 13. Router: 11, 22, 28.
checks/finish gate: 1, 4, 16, 27. Browser/Jev: 5, 14, 18. Approvals: 2, 6, 8, 10. Generative UI: 36.
Skills library: 30, 31. Design canvas/progress: 25. Usage ledger: 7, 29.

**(b) Genuinely separable new features.**

- **Local code index / search.** *Case:* every harness re-answers "where is X defined and who calls it"
  with ripgrep; a SQLite index of tree-sitter symbols + FTS5 BM25 + file PageRank exposed as one
  `search_code(query, budget)` teaches them to retrieve instead of stuffing the window (02 §F).
  *Over-engineering risk:* a monorepo solution for a 2,000-file project, and a stale index that misleads.
  *Kill:* top-5 misses the true definition on >20% of 50 real questions, or build >60 s on this repo —
  keep `text_search.rs`.
- **Eval harness.** *Case:* PandaCode cannot A/B over traffic, so replay over saved trajectories is the
  only honest comparison, and the prerequisite for every later routing/skill/cost claim (06 §3, §5, §10).
  *Over-engineering risk:* it spends real inference, and a 12-task suite produces noise that looks like
  signal. *Kill:* if a 20-task suite cannot detect a planted regression with a paired interval excluding
  zero, it measures nothing.
- **Provenance / taint layer.** *Case:* workers always run `full`, their output is trusted by the lead,
  and nothing distinguishes a user string from a web string (07 §1.2, §1.4, §10). *Over-engineering
  risk:* PandaCode owns no token stream, so this can only be a boundary label plus a sink check; a
  "taint tracking" ambition inside a harness is unimplementable. *Kill:* if "untrusted may not cross
  threads" breaks legitimate team flow beyond a stated false-positive budget, ship only the spotlighting
  envelope (a claim *reduction*, never prevention).
- **Memory service.** *Case:* notes and checkpoints accept any key with no decay or contradiction
  handling, so a reversed decision can be cited as current (02 §D, §H). *Over-engineering risk:* the
  vendor systems are resident loops PandaCode cannot run, with vendor-authored magnitudes; the defensible
  slice is a write policy over existing tables. *Kill:* if the reversed-decision probe misses 9/10, or
  the table adds no resolution over "newest N" briefs.

## 6. Cross-document consistency check

**(i) The three integrity labels.** 03 §3/§11 is authoritative:

> 03 §3: "Three labels in UI and gate refusals: `unchecked` / `checked (tests passed)` / `verified
> (tests passed and test integrity held)`." 03 §11: "Oracle edits during a 'make checks pass' objective
> → `checked` not `verified`."
> 06 §2: "Render `verified` / `checked` / `unchecked` next to the score instead of a bare `9.0`, reusing
> note 03's labels." 06 §9: "`verified_pass = check ran, passed, and no test file in turn_changes`."

**They match.** 06 defers to 03, and its §8/§9 predicates are the same. Canonical definition:
`unchecked` = no check ran; `checked` = a check ran and passed but the turn modified an oracle file
(tests, fixtures, snapshots, test scripts, CI), so integrity did not hold; `verified` = a check ran,
passed, and no oracle file appears in `turn_changes`. The one wording fix this check asked for is
applied: 03 §3 now renders `checked (tests passed, oracle edited)`, which no longer reads as "fine".

**(ii) One surface, two meanings.** Flagged, not merged:

| Word | Doc A | Doc B | Verdict |
| --- | --- | --- | --- |
| "memory" | 02 §D: team notes/checkpoints store | 06 §8: skills library as procedural memory | Different subsystems — scope the term in PRs. |
| "provenance" | 02 §H: turn/file audit trail on a memory row | 07 §1.4: trust label on a message (taint) | Different mechanisms — do not merge the implementations. |
| "eval" | 06: agent-quality harness over trajectories | 04 §11: router-decision replay | Different objects; both offline and local. |
| "context recovery" | 02 §A–B: a lossy compaction to improve | 04 §9: a context plan for a stable prefix | Same target, two lenses — complementary. |
| "worker file scopes" | 01 §2: coordination that shares decisions | 03 §16 / 07 §12: advisory only, never sandboxing | Both agree; 01's consistency argument is not a security claim. |

**(iii) Nothing re-proposes a shipped surface.** Verified per doc: routing ladders, failover, health
pausing (01, 04); effort *fitting* (01, 04); worker parking, notes, generation checks (01); prompt-cache
*accounting* (02, 04 add assembly/ordering, not measurement); token saver (02, 04); Jev (03 says results
are not proof; 05 extends, does not rebuild); generative UI (05 adds a schema, keeps the renderer);
simulator control (05 §12 unifies the schema, keeps control). **No doc** rebuilds any of them.

## 7. Do-not-build list (merged, deduplicated)

| Rejected | Why | Docs |
| --- | --- | --- |
| Multi-agent as an addition (swarm/handoff); fan-out as a quality lever | MAST's inter-agent misalignment; Anthropic's 50-subagents-for-a-simple-query failure | 01 |
| Self-consistency as a code sampling strategy | No discrete answer to vote on; reused only as verdict aggregation | 01 |
| Trained PRM / learned reward model | No training pipeline; a rate with an interval is more honest | 01, 06 |
| Full MCTS over trajectories; agent-level speculative execution | Every node is a process and a checkout; unmeasured | 01, 04 |
| Debate as the primary review; self-critique without an external signal; planner/executor as a second model | Independence is the default; Huang et al. show self-correction can degrade; the lead already plans | 01, 03, 06 |
| Transcript windowing as "context management" | Saves rendering work, not model context — a category error | 02 |
| Resident memory services (MemGPT/Letta, Zep/Graphiti, Mem0) and a vector-DB server | Need a resident loop/service; vendor-authored evidence; violates local-first | 02 |
| Semantic response caching; fine-tuning/training embeddings on the repo | A near-miss cache hit is a wrong answer; breaks the no-training posture | 02, 06 |
| Hierarchical summary-of-summaries | Thinner evidence than a structured state block | 02 |
| Router infrastructure (hosted router, from-scratch training, 4-bit profiler, constrained decoding on harness output, full A2A server) | Local-first; too little local data; int8 parity exists; boundary not owned; no demand | 04 |
| Speculative decoding | PandaCode does not serve token generation | 04 |
| Judge/repair shortcuts (averaging Council, Jev as proof, >1 repair, coverage gate, "LLM tests = verified", formal verification as a general gate) | Each hides a blocker or games a proxy; keep a floor and mutation grading | 03 |
| Whole-file rewrite / line-numbered diffs as model output | 59% vs 26% on aider's harness | 03, 05 |
| Speech-to-speech conversation | Dictation is deliberately not a conversation; measure preview first | 05 |
| Network-idle waiting; SoM as default; screenshot pruning as first saving | Unreliable on long-polling; model-dependent; pruning invalidates thinking blocks | 05 |
| Free-form agent HTML as a default; undo as a general safety net; simulator benchmarks as quality signals | Deceptive-design risk; files are not rewound; AndroidWorld is saturated/archived | 05 |
| Live A/B / canary; shadow traffic to a second live model | No accounts, no telemetry, n≈1; silent cost multiplication | 06 |
| Importing SWE-bench Verified / WebArena / OSWorld / GAIA; a dashboard on uncalibrated judges | Contaminated or environment-heavy; small n plus an uncalibrated judge is confidence without evidence | 06 |
| Meta-Harness / SICA self-editing | A model rewriting the code that gates it — unacceptable blast radius | 06 |
| "A guardrail model will catch injection"; spotlighting written as "prevented"; full CaMeL in-app; preventing covert channels | >90% ASR against adaptive attackers; reduces not eliminates; no interpreter and no loop; DNS/timing stay open | 07 |
| Worker scopes sold as sandboxing; making workers non-full-access; MFA for approvals | Advisory only; a waiting worker stalls the team; wrong for a local-first app | 07 |
| Claiming the audit log is immutable; reading the agent's justification to decide scope; replacing `always_ask`; trusting a local MCP server because it is local | Tamper-*evident* only; prose is evidence not authorisation; already correct; local runs with client privilege | 07 |

## 8. Suggested first PR — wire router difficulty into the effort that already fits

**Why this one.** Two reports rank it (01 #4, 04 #3), it is the only proposal here that *reduces* cost,
and it needs no migration or model download. Snell et al. (01 §11) and Anthropic's effort docs plus *The
Illusion of Thinking* (04 §4) agree allocation should follow difficulty; PandaCode computes difficulty
and discards it.

**Verified in the checkout.** `architect/routing.rs` defines `AutoRoute { difficulty: u8, .. }`
(line 23/34); `staff()` destructures it at line 337 but never uses it for effort. Line 334 takes
`assignment.reasoning_effort` as the only `wanted`; line 344 calls
`model_efforts::apply(&pick.provider, &pick.model, wanted, default)`, which fits a level to the model's
catalog, returns a note on change, and falls back to the inherited default. `model_efforts.rs` already
owns `EFFORT_LEVELS`, `fit`, `apply` and the catalog cache.

**The change.**
1. `src-tauri/src/architect/model_efforts.rs`: add `pub(super) fn from_difficulty(difficulty: u8, mode:
   crate::panda_router::Mode) -> Option<String>` mapping `≤3 → "low"`, `4–6 → "medium"`, `≥7 → "high"`,
   with `Quality` shifting one level up and `Cheap` one down (clamped to `low..high`). It returns a level,
   never fits — `apply` fits.
2. `architect/routing.rs`, in `staff()`'s **routed arm only** (the unrouted arm has no difficulty): when
   `assignment.reasoning_effort` is `None`, pass the derived level as `wanted` to `model_efforts::apply`
   and append its note to the routing note. Explicit `reasoningEffort` still wins; the refusal-relaunch
   stays as the safety net.
3. Set it **at dispatch only**, never per turn: a top-level effort change invalidates the prompt cache
   (01 §11, 04 §2.1). Keep the level stable within a worker's conversation; an escalation changes it only
   at a turn boundary.

**The test that proves it.** Seed the catalog with
`model_efforts::seed(provider, &[("m", &["low","medium","high"])])`, then assert
`from_difficulty(2, Balanced) == Some("low")` and `from_difficulty(8, Balanced) == Some("high")`; a
catalog lacking `high` fits it down to `medium` **with a note**; an explicit `reasoningEffort: "max"`
passes through `apply()` unchanged. Extend the existing `route()` test helper (it hardcodes
`difficulty: 1`) to take a difficulty, and add one `staff()` test that a difficulty-8 route opens at
`high` and a difficulty-2 route at `low`. This mirrors 01 §11's acceptance signal: median effort falls
for easy assignments and rises for hard ones on the replay fixtures, with no change in explicit-effort
behaviour.

**Not needed:** no UI, migration, dependency or network. If the replay fixtures were never recorded, the
unit tests above ship it and the replay check becomes the first Wave-2 follow-up.
