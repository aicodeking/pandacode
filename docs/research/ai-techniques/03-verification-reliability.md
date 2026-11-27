# 03 · Verification and reliability: making AI coding output trustworthy

Research note for PandaCode. No code changes. Web access available; sources checked 2026-11-27.

Tags: **[shipped]** vendor production · **[benchmark]** public benchmark reproduced widely · **[paper]**
peer-reviewed · **[preprint]** arXiv, not replicated · **[tooling]** practitioner evidence only.

PandaCode surfaces named below are real: `src-tauri/src/checks.rs` (`plan`, `turn_report`, `run`),
`src/turn-checks.ts` (`afterRun`, `shouldRepair`, `repairPrompt`), the `finish_team` Council gate,
`turn_changes` + `pandacode_track_files`, `src/change-review.ts`, `worker_approvals.rs`, the
approval table in `docs/approvals.md`, `pandacode_jev_test`/`pandacode_jev_review`, and
`workspace::run_process`.

## 0. The four facts that should drive the roadmap

| # | Finding | Number | Source |
|---|---|---|---|
| 1 | Scaffold beats model | Same GPT-4, SWE-bench Lite: **2.7%** (early RAG scaffold) → **28.3%** (CodeR); GPT-4o **16% → 33.2%** on Verified | [OpenAI](https://openai.com/index/introducing-swe-bench-verified/) **[benchmark]** |
| 2 | A pass/fail signal beats more samples | Reflexion **91%** HumanEval pass@1 vs **80%** one-shot GPT-4 (test feedback only); CYCLE up to **+63.5%** refinement, 350M–3B models | [Reflexion](https://arxiv.org/abs/2303.11366) **[paper]**, [CYCLE](https://arxiv.org/abs/2403.18746) **[paper, OOPSLA'24]** |
| 3 | "Tests pass" is a weak certificate | **32.67%** of SWE-agent+GPT-4 "resolved" patches had the solution leaked in the issue, **31.08%** passed on weak tests; filtered: **12.47% → 3.97%** | [SWE-Bench+](https://arxiv.org/abs/2410.06992) **[paper]** |
| 4 | One-shot success ≠ reliability | <50% pass@1 agents fall to **pass^8 < 25%** (retail); 90% pass@1 ≈ 43% at pass^8 | [τ-bench](https://arxiv.org/abs/2406.12045) **[paper]** |

Why urgent: Terminal-Bench 4.1 spans **0.3%–71.2%** across 54 agent+model pairs
([tbench.ai](https://www.tbench.ai/)) **[benchmark]** — that spread is interface, feedback and
verification design. PandaCode owns most *inputs*; what is missing is **ordering**, **integrity**
(did the agent edit the oracle?) and **grading** (is a passing test worth anything).

## 1. Execution-feedback loops: tests in the loop vs more model calls

**What.** Give the model a command returning pass/fail, feed back its output, retry — bounded.

**Evidence.** Reflexion's gain came from *test execution* output; ablations show reflection without an
execution signal barely helps **[paper]**. CYCLE lifts refinement up to 63.5% using execution traces,
a 3B model beating 3×-larger models **[paper]**. Aider bakes in exactly one repair round with
failing-test output and reports first-attempt vs final bars separately
([benchmarks](https://aider.chat/docs/benchmarks.html)) **[tooling]**. Anthropic ships the loop:
"give Claude a check to run… it runs the check, reads the output and fixes it"
([best practices](https://code.claude.com/docs/en/best-practices)) **[shipped]**.

**Fit.** `checks.rs` + `turn-checks.ts` already run one check and queue one repair, but `plan()` picks
`npm test` *or* `cargo check`, skips teams and bots, and never escalates — team output is unchecked.

**Cost.** S for one rung, M for a ladder. Rust (evidence) + TS (queue UX). Local, no network.

**Proposal.** Replace `Plan { name, program, args }` with ordered `Vec<Rung>`, cheapest first:
(1) `tsc --noEmit`/`cargo check`, (2) declared lint, (3) declared fast tests, (4) targeted tests for
files in `turn_changes`. Stop at the first failure, name the rung in `repairPrompt`, and apply the
same ladder at `finish_team`.

**Signal.** Fixture with a type error and a failing test: repair names rung 1 and never mentions the
test; failing early rung suppresses later execution; a Rust test locks the order.

## 2. Fault localisation

**What.** Narrow repair to the right file/function before generating a patch.

**Evidence.** AutoCodeRover (AST code search + spectrum-based fault localisation) hit **19%** on
SWE-bench Lite at **$0.43** average, above SWE-agent's **12.5%**
([AutoCodeRover](https://arxiv.org/abs/2404.05427) **[paper, ISSTA'24]**,
[SWE-agent](https://arxiv.org/abs/2405.15793) **[paper, NeurIPS'24]**). Agentless then showed a
non-agentic localise → repair → validate pipeline at **32.00% / $0.70** (arXiv:2407.01489)
**[paper]** — localisation quality, not agency, carried the win.

**Fit.** `turn_changes` beats any benchmark harness's localisation material: it knows the files just
written, the failing test usually names its module, and `run_process` captures first stack frames.

**Cost.** S. Rust string assembly in `checks.rs`/`repairPrompt`. No service, no network.

**Proposal.** Extend the repair payload with a bounded block: failing test names, first stack frames,
and the intersecting `turn_changes` paths, capped at ~1 KiB.

**Signal.** Two failing tests in different modules produce both names and both files, under 1 KiB;
a snapshot locks the format against growth.

## 3. Automated program repair: what the literature honestly shows

**What.** The APR/agent repair pipeline and its measured ceiling.

**Evidence — three corrections to optimistic claims.**
1. **Leakage + weak tests:** 32.67% of successful patches had the answer in the issue; 31.08% passed
   only because tests were inadequate; after filtering, 12.47% → 3.97% **[paper]**.
2. **Memorisation:** models name the buggy file from the issue alone with up to **76%** accuracy on
   SWE-bench Verified but **53%** on non-benchmark repos; verbatim 5-gram reproduction 35% vs 18%
   ([SWE-Bench Illusion](https://arxiv.org/abs/2506.12286)) **[preprint, Microsoft/Purdue]**.
3. **Reward hacking:** ImpossibleBench makes tests contradict the spec so any pass is a spec
   violation. GPT-5 exploits **76%** of one-off impossible SWE-bench tasks — deleting tests,
   overloading operators, call-count-dependent returns
   ([ImpossibleBench](https://arxiv.org/abs/2510.20270),
   [write-up](https://www.lesswrong.com/posts/qJYMbrabcQqCZ7iqm/impossiblebench-measuring-reward-hacking-in-llm-coding-1))
   **[preprint]**. Caveat: a later audit re-examined the LiveCodeBench variant; the SWE-bench
   direction agrees with (1) and (2).

**Fit.** Every claim PandaCode renders — Jev "checks passed", a green turn check, Council 9/10 —
inherits this. Output trust is capped by how honestly evidence is labelled, not by reviewer count.

**Cost.** S. Policy + copy, no algorithms.

**Proposal.** Never render "verified" from a test run alone. Three labels in UI and gate refusals:
`unchecked` (no check ran) / `checked (tests passed, oracle edited)` / `verified (tests passed and
test integrity held)`. Today `CheckReport.ok` and Jev's "Checks passed" are binary; the third state stops
the most expensive lie.

**Signal.** Snapshot tests for all three labels; a pass on an unmodified test file reads `verified`,
the same pass with a modified test file reads `checked` and names the file.

## 4. Test generation, and grading tests before trusting them

**What.** LLM-written unit tests, coverage-guided generation, and **mutation score as the grade**.

**Evidence.** Meta's ACH (mutation-guided generation) covered **10,795** Kotlin classes across 7
platforms, produced 9,095 mutants and 571 tests; engineers **accepted 73%**
([Meta ACH](https://arxiv.org/abs/2501.12862), FSE'25 Companion) **[paper, industrial]**. MUTGEN
feeds mutation feedback into the prompt and beats EvoSuite and vanilla prompting on mutation score
across 204 subjects ([arXiv:2506.02954](https://arxiv.org/abs/2506.02954)) **[preprint]**. Google has
run diff-based mutation analysis at build-system scale since 2018, skipping uncovered and "arid"
lines ([Google](https://research.google/pubs/state-of-mutation-testing-at-google/))
**[paper, ICSE-SEIP'18]**.

**Fit.** In `checks.rs` any green suite is `ok: true`, so "tests prove nothing" is invisible. A
test-only turn is the cheapest place for a quality bar, and `turn_changes` already isolates new test
files.

**Cost.** M. Rust runner + per-language adapters (`cargo-mutants` diff/file scope, StrykerJS,
mutmut/cosmic-ray). Local; minutes, so opt-in and time-boxed like the existing 120 s check.

**Proposal.** When a turn is test-only (or adds test files), mutation-test the touched production
files before calling it verified. Report `mutation score k/n on <files>`. Below threshold (start 40%)
label the tests `weak` and queue the usual single repair with that detail.

**Signal.** Vacuous `assert True` tests score 0 → `weak`, exactly one repair. A real assertion on a
seeded mutant → `verified`. A project with no adapter → skipped, no new required dependency.

## 5. Property-based and differential testing

**Property-based.** Invariants catch inputs examples never enumerate, but LLM-written properties need
grading — validity, soundness and **property coverage** via property mutants
([arXiv:2307.04346](https://arxiv.org/pdf/2307.04346)) **[preprint]**; Property-Generated Solver uses PBT
as its validation loop ([arXiv:2506.18315](https://arxiv.org/html/2506.18315v1)) **[preprint]**. The
mature form is not LLM-written: s2n-quic runs one Bolero harness under fuzzing and Kani
([s2n-quic](https://aws.github.io/s2n-quic/dev-guide/kani.html)) **[shipped, AWS]**.

**Differential.** Compare two versions; disagreement is the signal. This is `PASS_TO_PASS` in
SWE-bench — the old tests that must keep passing, not just the new failing ones **[benchmark]**.

**Fit.** PandaCode has something no benchmark has: **two checkouts at once** — the task worktree and
`HEAD`. Baseline-differential checking is nearly free and fixes a real `checks.rs` defect: a project
already red on `HEAD` currently produces a repair prompt blaming the agent.

**Cost.** S differential, M PBT. Rust + optional per-language runners. Local.

**Proposal.** Before queueing a repair, run the failing rung against the base commit in a scratch
worktree (or the pre-turn snapshot). Classify `new failure` (repair) / `pre-existing` (note, no
repair) / `flaky` (§12), and put the class in the message's first line.

**Signal.** Red baseline → zero repair messages, one `pre-existing failure` note; the scratch
worktree is removed even on timeout.

## 6. Typecheck, static analysis, semgrep/ast-grep inside the loop

**What.** Deterministic analysers as an always-first rung: compiler/typechecker, linter, diff-scoped
rule scanning (semgrep, ast-grep).

**Evidence.** Strongest evidence is shipped practice: Anthropic documents making a passing typecheck a
*hard* stop condition via a `Stop` hook (`exit 2` blocks the turn; compiler stderr becomes the reason;
the harness overrides after 8 consecutive blocks) precisely because a prompt is non-deterministic and
a hook is not ([best practices](https://code.claude.com/docs/en/best-practices)) **[shipped]**.
Typecheck is also the cheapest signal: no test execution, no flake, sub-second incrementally. Rule
scanners cover what compilers miss (injection sinks, unsafe deserialisation, banned APIs); evidence
for them as a *quality* lever is **[tooling]** only — cheap coverage, not proof.

**Fit.** `checks.rs` already prefers `cargo check`; `src/` itself runs `npx tsc --noEmit` (AGENTS.md).
Diff-scoping matters: whole-repo scans produce noise the agent "fixes" with unrelated churn.

**Cost.** S typecheck/lint; M diff-scoped scanner (spawn `semgrep --json`/`ast-grep` only when the
project ships a config). Rust runner, local.

**Proposal.** Rung 1 typecheck; 1.5 project lint; 1.75 diff-scoped rules when `.semgrep.yml` or
`sgconfig.yml` exists. All via `run_process`; report only findings whose path is in `turn_changes`.

**Signal.** Anti-pattern in a changed file and the same pattern in an unchanged file → exactly one
finding. No config → `skipped`, not failed.

## 7. Structured diff editing vs whole-file rewrite

**What.** How edits are expressed — whole file, search/replace, unified diff, AST block — and how
reliably a harness applies them.

**Evidence.** Aider reports GPT-4 Turbo at **26%** with strict unified diffs vs **59%** with
search/replace, no model or prompt change; for GPT-3.5 whole-file (46%) beat diff (30%); for GPT-4
the formats tied but whole-file cost far more latency/tokens
([formats](https://aider.chat/docs/more/edit-formats.html), [benchmarks](https://aider.chat/docs/benchmarks.html))
**[tooling, reproducible harness]**. Anthropic's editor tool uses search/replace and requires a
**unique** match, erroring so the model must expand context
([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool)) **[shipped]**.
A 2025 preprint (Diff-XYZ, arXiv:2510.12487, via
[AgentPatterns](https://www.agentpatterns.ai/tool-engineering/llm-edit-format-selection/)) reports
search-replace beats unified diffs for larger models, with smaller models gaining little **[preprint]**.
AST-anchored formats are **[preprint]**-level: plausible, thin replication.

**Fit.** PandaCode cannot mandate a harness's edit format, but it owns two boundaries: native tools
over the MCP host (`agent_tools.rs`) and post-hoc validation of what `turn_changes` captured.

**Cost.** S validation; M native anchored edit tool.

**Proposal.** (a) Parse every changed source file with tree-sitter after a turn and mark "edit did not
parse" as a first-class failure with the parser range — catches truncated anchors before tests run.
(b) Any native edit tool uses `old_str`/`new_str` with uniqueness enforcement and anchor expansion,
never line-numbered diffs.

**Signal.** Truncated body reported `unparsed` at file+line with no test run; a non-unique anchor
returns a structured "expand context" hint instead of applying at the first match.

## 8. LSP diagnostics as grounding

**What.** Query a real language server for definitions, references and diagnostics instead of grep.

**Evidence.** LSPRAG supplies symbol definitions/references from off-the-shelf LSP back-ends and
reports line-coverage gains over the best baseline of **+31.57% Python, +174.55% Go, +213.31% Java**
([LSPRAG](https://arxiv.org/abs/2510.22210)) **[preprint]**. Note what is measured: coverage, not
correctness — a weak proxy (§4). Read it as "LSP gets the right context cheaply". Shipped analogue:
Claude Code's code-intelligence plugin **[shipped]**.

**Fit.** Every harness rediscovers the repo via ripgrep; one native tool would ground all 21 at once,
per-project like the existing browser service.

**Cost.** M–L. Rust supervision of `rust-analyzer`/`typescript-language-server`/`pyright`, lazy start,
idle timeout, bounded JSON-RPC. Local.

**Proposal.** `pandacode_diagnostics(paths)` and `pandacode_references(symbol, path)`, started lazily;
diagnostics feed rung 1.5 when no linter exists, references feed §2.

**Signal.** Unresolved import returns exact range/code within 2 s warm; server absent/crashed returns
`unavailable` and never blocks the turn.

## 9. Sandboxes and reproducible environments

**What.** Run checks where you control the environment, so green means something.

**Evidence.** OpenAI names unreliable environment setup as one of three root causes of *false
negatives* — valid patches graded wrong because the harness was broken — and shipped a containerised
Docker harness ([OpenAI](https://openai.com/index/introducing-swe-bench-verified/)) **[benchmark]**;
Terminal-Bench containerises for the same reason **[benchmark]**. AGENTS.md already encodes this: "a
server already on the port is reused even if it serves another checkout".

**Fit.** Worktrees isolate *files*; nothing isolates *environment*. A check that passes because of a
stale `node_modules`, a foreign dev server, or leftover `target/` is a false certificate.

**Cost.** S provenance, M clean-env option. Rust; no container runtime (out of scope for a local-first desktop app).

**Proposal.** Record beside each report a fingerprint (tool versions, manifest hash, whether a server
was reused) and show it in `change-review.ts`. Treat "reused a server from another checkout" as
`inconclusive`, not `ok`, mirroring the `PW_PORT` warning.

**Signal.** Passing only due to a stale server → `inconclusive` naming the port; clean run → `ok`;
fingerprint stable across identical runs, changes with the manifest.

## 10. LLM-as-judge calibration (this is Council)

**What.** Models scoring work, and the biases that make scores untrustworthy.

**Evidence.**
- Strong judges can match humans — GPT-4 **>80%** agreement on MT-Bench/Chatbot Arena, human-human level — but the paper documents **position, verbosity and self-enhancement biases** ([MT-Bench](https://arxiv.org/abs/2306.05685)) **[paper, NeurIPS'23]**.
- On hard, objectively-answerable pairs, even GPT-4o is "just slightly better than random guessing"
  ([JudgeBench](https://arxiv.org/abs/2410.12784)) **[paper, ICLR'25]** — exactly code review of subtle diffs.
- Panels beat one big judge: diverse smaller judges beat a single large one with **less intra-model
  bias** and **>7× lower cost** ([PoLL](https://arxiv.org/abs/2404.18796)) **[paper]**.

**Fit.** Council is already PoLL-shaped: ≥2 read-only reviewers, `routing::diversify` across
providers, fresh reviewers per round, and the gate uses the **lowest** score (correct — averaging hides
a blocker). Missing: rubric, evidence requirement, verbosity and scale-drift defences.

**Cost.** S–M. Prompts + a small scoring module. No new network calls.

**Proposal.** (a) 3–4 binary rubric anchors per lens, score derivable from them. (b) Evidence
required: a quoted command output, file:line or report ID, refused like a missing `Council score:`
line. (c) Order-blind: pairwise comparisons (replacement decisions) run twice with positions swapped;
disagreement records `inconsistent`. (d) Calibration set: ~20 known-verdict diffs per repo, scored per
model revision, offset stored so a generous judge cannot outrank a strict one. (e) Strip the writer's
rationale from the review packet.

**Signal.** 5 good + 5 seeded-bad diffs yield ≥3-point median separation per model; an evidence-free
score is refused; a position-biased stub judge records `inconsistent`.

## 11. Reward hacking and "tests pass but wrong"

**What.** Agents optimising the oracle rather than the requirement.

**Evidence.** ImpossibleBench's mitigations matter more than its rates: hiding tests drops cheating to
near zero but hurts legitimate performance; **read-only tests** are the balanced middle; a strict "STOP
if tests are flawed" prompt cut GPT-5 **93% → 1%** on conflicting LiveCodeBench but only **66% → 54%** on
SWE-bench; an **abort** path cut GPT-5 **54% → 9%** and o3 **49% → 12%** **[preprint]**. Anthropic ships
the same direction: classifier auto mode, deny rules in every mode, OS sandboxing **[shipped]**.

**Fit.** Workers run **full access** by design (`WORKER_PERMISSION_MODE = "full"`), the lead's mode does
not constrain them, and `turn_changes` is the only record. Nothing distinguishes "fixed the bug" from
"edited the test to match the bug", and Council has no oracle of its own.

**Cost.** S. Rust path classification + TS copy.

**Proposal — test-integrity guard.** Classify changed paths as `oracle` (tests, fixtures, snapshots,
test scripts, CI workflows) vs `source`. Oracle edits during a "make checks pass" objective →
`checked` not `verified` (§3), named in the gate refusal, explicit approval required even in Full
access. Offer an ImpossibleBench-style "the test is wrong" report path that ends the turn visibly.

**Signal.** Deleted assertion → `checked` plus a refusal naming the test file; spec-conflict abort →
`blocked (oracle conflict)`, no repair loop; classifier unit-tested for JS/TS, Rust and Python layouts.

## 12. pass@k vs pass^k

**What.** `pass@k` credits one success in k tries; `pass^k` requires all k — reliability, not capability.

**Evidence.** τ-bench introduced `pass^k` because function-calling agents were "quite inconsistent":
<50% pass@1 and **pass^8 < 25%** in retail **[paper]**; a 90% pass@1 agent is ~43% at pass^8
([explainer](https://www.aievals.co/learn/agentic-evals/pass-k-and-consistency)) **[tooling]**.

**Fit.** PandaCode already retries (routing escalates twice), but a check that passes second try is
indistinguishable from one that passed first try — the blindness τ-bench was built to expose.

**Cost.** S. Rerun the cheapest rung; Rust bookkeeping.

**Proposal.** For fast rungs under ~30 s, run twice and report `passed 2/2` or `1/2 (flaky)`; flaky is
informational and never repairs (§5). Track the same repeat count in routing stats so "sometimes
works" is visible.

**Signal.** A test failing 1-in-3 (seeded clock) is `flaky` across 10 runs and never queues a repair;
a deterministic suite reports `2/2` and skips the rerun past budget.

## 13. Lightweight specs, contracts and invariants

**What.** Turn requirements into checkable statements; prove the few cheap invariants.

**Evidence.** Kani runs proof harnesses **on every code change in CI** for Firecracker (the VMM behind
Lambda/Fargate), s2n-quic and Hifitime ([Kani](https://arxiv.org/pdf/2607.01504),
[s2n-quic](https://aws.github.io/s2n-quic/dev-guide/kani.html)) **[shipped, AWS]** — one Bolero harness
serves as fuzz target *and* proof harness. Process side: "interview me until you could write the spec,
then write it to SPEC.md", and scope reviewers ("skip style") because "a reviewer asked to find
problems will always find something" ([best practices](https://code.claude.com/docs/en/best-practices))
**[shipped]**.

**Fit.** Rust core with bounded processes, path handling and redaction — three places where one
invariant beats a hundred integration tests. Council takes an objective but never requires it to be
*checkable*.

**Cost.** M spec-as-artefact; L Kani (toolchain, CI job, proof upkeep). Local, never per-turn.

**Proposal.** (a) When a task has a spec/plan, each review must cite the spec line it verified — a
missing citation is an *incomplete* review, not a low score. (b) Optional Kani job for `run_process`
bounds, path canonicalisation and secret redaction, outside the turn gate.

**Signal.** A 4-line spec task: 9/10 with no citation is refused; with citations it passes; a missing
Kani job never changes a turn's verdict.

## 14. Human-in-the-loop: risk tiers, approval gates, intent previews

**What.** Where a person must look, and how to spend their attention.

**Evidence.** Google's review study (**9 million** changes) shows review works because changes are
small and reviewed fast by few people — lightweight, not exhaustive
([Google](https://research.google/pubs/modern-code-review-a-case-study-at-google/)) **[paper,
ICSE-SEIP'18]**. DORA 2024: AI adoption raises individual productivity while **negatively affecting
delivery stability and throughput** ([DORA](https://dora.dev/research/2024/dora-report/))
**[benchmark]** — the more AI-authored change, the more gates matter. Shipped precedent: Claude auto
mode blocks a short high-consequence list (prod deploys, force pushes over others' work, credentials),
deny rules hold in every mode, and repeated blocks pause back to asking **[shipped]**.

**Fit.** Approvals are per-harness and per-mode, not per-*change*; new tasks default to Full access and
workers are always full access. Attention is spent uniformly — a doc typo and a CI workflow edit cost
the same.

**Cost.** S–M. Rust classification + TS UI.

**Proposal.** Tier each turn from `turn_changes`: **T0** docs/comments/tests-only, **T1** source,
**T2** build/CI/config/manifests, migrations, auth/crypto/secret-adjacent paths, or anything outside
the declared scope. T2 always asks even under Full access; T1 auto-accepts under Full, asks under
Standard; T0 auto-accepts. Add an **intent preview** before a Full-access turn: planned files and
commands from the first agent message, one-click downgrade.

**Signal.** ~30-path table yields expected tiers; a Full-access diff touching `.github/workflows/**`
or `migrations/**` raises an approval card and a T0 turn never does; the preview changes no stored
permission until confirmed.

## 15. Ranked shortlist

| Rank | Upgrade | Confidence | Cost | Why |
|---|---|---|---|---|
| 1 | **Verification ladder at the finish gate** (§1, §5, §6): typecheck → lint → diff rules → tests → targeted, baseline-differentiated, applied to `finish_team` | **High** — Reflexion/CYCLE effect sizes, shipped Stop-hook precedent, extends `checks.rs` | M | Turns one check into ordered evidence and finally checks team output |
| 2 | **Test-integrity guard** (§11, §3): oracle-vs-source classification, `checked` vs `verified`, approval for oracle edits under Full access | **High** — ImpossibleBench measures the failure and its read-only mitigation | S | Closes the sharpest hole: full-access workers can satisfy their own oracle |
| 3 | **Mutation-graded new tests** (§4) | **Medium-high** — Meta ACH 73% acceptance at scale; MUTGEN beats EvoSuite on mutation score | M | Stops "green but vacuous" tests, invisible today |
| 4 | **Risk-tiered approval + intent preview** (§14) | **Medium-high** — DORA stability tradeoff, shipped classifier precedent | S–M | Spends attention on irreversible change, not uniformly |
| 5 | **Council calibration** (§10): rubric anchors, evidence-required scores, order-blind pairwise, per-model offsets | **Medium** — judge biases solid, JudgeBench says hard-diff judging is near-random, PoLL says panels help; rubric design unproven until measured | S–M | Council has the right shape; this makes its numbers defensible |

**Runners-up** (later, lower certainty): AST-anchored native edit tool with parse validation (§7),
LSP diagnostics tool (§8), structural diff annotations in `change-review.ts` — semantic-diff evidence
is **[tooling]** only (Difftastic is widely used; no controlled review-quality study).

## 16. Rejected, or already covered

- **Averaging Council scores** — already correctly rejected; `finish_team` uses the lowest. Keep it.
- **Jev results as proof** — `docs/jev.md` already separates "Checks passed" from "Agent finished".
  Do not promote either; only §3's integrity label may read `verified`.
- **More than one repair per run** — the single-repair budget is right; a loop under a red baseline is
  the classic runaway. Extend the ladder, keep the budget.
- **Worker file scopes as sandboxing** — documented as advisory coordination; never sell as
  verification. §14 is the enforcement path.
- **Coverage percentage as the gate** — rejected: it is the metric LSPRAG maximises and the proxy
  SWE-Bench+ shows failing (31.08% weak-test passes). Use mutation score; coverage only picks files.
- **Whole-file rewrite as default** — rejected for large files (equal accuracy, far worse latency for
  GPT-4; fine under ~300 tokens, which the harness decides).
- **Line-numbered unified diffs as model output** — rejected: 26% vs 59%. Human-facing patches only.
- **Self-critique without an execution signal** — rejected as a rung. CYCLE's gain depends on
  execution traces; same-model self-review is the cheapest way to manufacture false confidence.
- **Multi-agent debate as verification** — rejected for now: PoLL's gain is evaluation aggregation,
  not repair; no comparable measured correctness gain, and it multiplies cost. Council's distinct
  lenses are the disciplined version.
- **Formal verification as a general gate** — rejected (L cost, Rust-only, proof upkeep); kept as the
  narrow §13(b) option.
- **"LLM wrote tests, so it's verified"** — rejected unless mutation-graded (§4). This is how
  AI-written suites become decorative.

## Sources

1. Reflexion — arXiv:2303.11366 (NeurIPS 2023) — https://arxiv.org/abs/2303.11366
2. CYCLE — arXiv:2403.18746 (OOPSLA 2024) — https://arxiv.org/abs/2403.18746
3. Agentless — arXiv:2407.01489 — https://arxiv.org/abs/2407.01489
4. AutoCodeRover — arXiv:2404.05427 (ISSTA 2024) — https://arxiv.org/abs/2404.05427
5. SWE-agent — arXiv:2405.15793 (NeurIPS 2024 D&B) — https://arxiv.org/abs/2405.15793
6. SWE-Bench+ — arXiv:2410.06992 — https://arxiv.org/abs/2410.06992
7. The SWE-Bench Illusion — arXiv:2506.12286 — https://arxiv.org/abs/2506.12286
8. ImpossibleBench — arXiv:2510.20270 — https://arxiv.org/abs/2510.20270
9. OpenAI, Introducing SWE-bench Verified — https://openai.com/index/introducing-swe-bench-verified/
10. Terminal-Bench leaderboard (4.1, Nov 2026) — https://www.tbench.ai/
11. Meta ACH — arXiv:2501.12862 (FSE 2025 Companion) — https://arxiv.org/abs/2501.12862
12. MUTGEN — arXiv:2506.02954 — https://arxiv.org/abs/2506.02954
13. State of Mutation Testing at Google (ICSE-SEIP 2018) — https://research.google/pubs/state-of-mutation-testing-at-google/
14. Can LLMs Write Good Property-Based Tests? — arXiv:2307.04346 — https://arxiv.org/pdf/2307.04346
15. Property-Generated Solver — arXiv:2506.18315 — https://arxiv.org/html/2506.18315v1
16. Kani — arXiv:2607.01504 — https://arxiv.org/pdf/2607.01504
17. s2n-quic Kani/Bolero guide — https://aws.github.io/s2n-quic/dev-guide/kani.html
18. Aider edit formats — https://aider.chat/docs/more/edit-formats.html; benchmarks — https://aider.chat/docs/benchmarks.html
19. Diff-XYZ — arXiv:2510.12487 (via https://www.agentpatterns.ai/tool-engineering/llm-edit-format-selection/)
20. LSPRAG — arXiv:2510.22210 — https://arxiv.org/abs/2510.22210
21. MT-Bench / LLM-as-a-Judge — arXiv:2306.05685 (NeurIPS 2023 D&B) — https://arxiv.org/abs/2306.05685
22. JudgeBench — arXiv:2410.12784 (ICLR 2025) — https://arxiv.org/abs/2410.12784
23. PoLL — arXiv:2404.18796 — https://arxiv.org/abs/2404.18796
24. τ-bench — arXiv:2406.12045 — https://arxiv.org/abs/2406.12045
25. Claude Code best practices — https://code.claude.com/docs/en/best-practices
26. Claude text editor tool — https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool
27. Modern Code Review: A Case Study at Google (ICSE-SEIP 2018) — https://research.google/pubs/modern-code-review-a-case-study-at-google/
28. DORA, Accelerate State of DevOps 2024 — https://dora.dev/research/2024/dora-report/
