# 04 · Model layer, routing and inference efficiency

What PandaCode could change in the layer that chooses models, composes prompts and
schedules agent runs. Every claim is tied to a primary source read on 27 November
2026 (abstract or documentation page, not full replication); each technique names
its exact landing surface, cost and an acceptance signal.

## Method and boundary

Web access was available. Sources: RouteLLM and FrugalGPT, Anthropic and OpenAI
provider documentation, arXiv/NeurIPS papers on effort, quantisation and bandits,
the MCP and A2A specifications, MTEB/BEIR, Chroma's context-rot report and the AWS
Builders' Library.

PandaCode's baseline is Panda Router v4 (`src-tauri/src/panda_router/`): an int8
ONNX Ettin-32M profiler, MIRT card matcher, frozen logistic success head with a
lower confidence bound, expected-cost policy, escalation ladder, tier blend and a
frozen failure-offset table (`success.rs` `escalation_logit`).

**The hard constraint on this whole area:** PandaCode does not build provider
request bodies for agent turns; installed CLIs and ACP harnesses do. Anything about
`response_format`, `cache_control`, `reasoning_effort` or grammars is a
*harness-configuration* or *scheduling* lever, not a field PandaCode can set.
Proposals that pretend otherwise are marked speculative. Already delivered, not
re-proposed: routing and ladders, health pausing, account pooling, the usage ledger
with cache read/write counts, token saver, effort fitting
(`architect/model_efforts.rs`), tiers, exclusions and failover.

## Baseline, precisely

| Surface | Exists | Gap relevant here |
| --- | --- | --- |
| Task→difficulty | ONNX profiler + keyword fallback | Fallback is admitted "clearly weaker"; never measured against the profiler |
| Model choice | Matcher + success head + expected cost | Head and escalation offsets frozen; no local outcome learning |
| Failure handling | Ladder, `replaces`, health pause | Fixed λ; `W_LATENCY = 0.0`, so the latency axis is decorative |
| Effort | Fitted to catalog, refusal relaunch | Level never *chosen* from difficulty or cost mode |
| Cache | Read/write counts parsed and displayed | No dispatch ordering, prewarm, or hit-rate regression signal |
| Structured output | Worker report parsing, MCP tool args | No schema validation/repair, no cross-harness canonical form |
| Evaluation | Unit tests, ignored `live_team_routing` | No persisted outcomes, replay or counterfactual evaluation |

## 1. Routing and cascades

**1.1 Preference-trained routers.** Learn a router from pairwise preference data
instead of rules; serve with similarity-weighted Elo, matrix factorisation, a BERT
classifier or an LLM classifier. RouteLLM
([paper](https://arxiv.org/abs/2406.18665),
[LMSYS write-up](https://www.lmsys.org/blog/2024-07-01-routellm/), 2024,
open-source, widely reproduced) routes GPT-4 Turbo against Mixtral 8x7B and reaches
95% of GPT-4 quality with cost reductions of **over 85% on MT-Bench, 45% on MMLU
and 35% on GSM8K**. Matrix factorisation needs 26% GPT-4 calls on MT-Bench; adding
an LLM judge to the training data halves that to 14%. The same routers transfer to
a Claude 3 Opus / Llama 3 8B pair without retraining. It validates the shape
PandaCode ships and supplies the two numbers to hold upgrades to: quality at 95% of
the strong model, cost saved by not calling it. Cost: L training, S serving; local.
PandaCode already has the serving half.

**1.2 Cascades.** Try a cheap model, verify or score, escalate only on failure.
FrugalGPT ([arXiv 2305.05176](https://arxiv.org/abs/2305.05176), 2023,
foundational) matches the best single model (GPT-4) "with up to 98% cost
reduction", or improves accuracy 4% at equal cost. `policy.rs` already computes
expected cost including failure (`E = c + (1-P)(c_next + L)`) and returns a
three-rung ladder — a cascade with a fixed penalty (`FAILURE_PENALTY_USD = 0.02`).
What is missing is learning the order from outcomes rather than fixing λ and the
offsets; the machinery exists, the data does not.

**1.3 Bandit-style online selection.** Treat choice as a contextual bandit:
explore, exploit, bound regret, no offline dataset. Poon et al.,
*Online Multi-LLM Selection via Contextual Bandits*
([arXiv 2506.17670](https://arxiv.org/abs/2506.17670), 2025) gives a LinUCB-style
algorithm with sublinear myopic regret and no offline fine-tuning, reporting better
accuracy **and** cost than existing routers; *Learning to Route LLMs from Bandit
Feedback* ([arXiv 2510.07429](https://arxiv.org/abs/2510.07429), 2025) supports this
(abstract only). Maturity: research. The frozen head cannot know that *this*
account's Haiku struggles with flaky TypeScript tests, or that a harness version
regressed; health pausing observes failures but discards the signal after the pause.

**1.4 When a classifier beats heuristics — and when it does not.** This is the most
decision-relevant evidence in the area and is usually misread. Learned routers win
when the signal is in the *prompt*: RouteLLM's routers transfer across model pairs,
so they learned problem characteristics, not model identities. They lose out of
distribution — on MMLU trained only on Arena data, **all RouteLLM routers performed
at near-random level**, fixed by ~1,500 golden labels (under 2% of training data).
They also lose when the decision depends on facts the classifier never saw: account
access, quota state, harness version, outage. PandaCode's cards are "estimates, not
measurements" (`docs/model-routing.md`). The honest split: **classifier for
task→difficulty (stable), online updates for model→outcome (local,
non-stationary)** — the frozen head should be a prior, not the final word.

**1.5 Proposal — local outcome ledger and replayable calibration.** Persist one row
per routed attempt (new table at schema 38, e.g. `routing_outcomes`): profile hash,
category and difficulty bucket, chosen card, mode, decision P and lower bound,
`decidedBy`, cost estimate, measured tokens/latency from the usage ledger, the
lead's check result, whether `replaces` followed, and the escalation step. No prompt
text. Two consumers:

1. **Replay** (offline): recompute the policy's pick under candidate parameters and
   compare Brier/NLL of P, escalation rate and mean cost on the last N outcomes —
   counterfactual logging without telemetry, since the data never leaves SQLite.
2. **Bounded online calibration**: per (category, card) Beta posterior over success,
   applied as a *small* multiplier like the tier blend in `tiers.rs`, with Thompson
   sampling only in the exploration slot the ladder already reserves. Never override
   health pauses, exclusions or the free-model guard.

Turn `W_LATENCY` on only once measured latency exists. **Acceptance:** replay over
≥200 outcomes improves Brier by a pre-registered margin (e.g. 5% relative),
escalation rate does not rise, and no model's pause rate changes. Behind a setting,
default off until replay passes. **Cost:** M — one migration, one Rust module beside
`success.rs`, a debug-only replay command. Local.

## 2. Prompt caching mechanics and economics

**2.1 What the providers do.** Anthropic
([docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)): opt
in per block (`cache_control`) or with one top-level field, prefix order
`tools` → `system` → `messages`; 5-minute TTL refreshed free on every hit, 1-hour
TTL available; **5-minute writes 1.25×, 1-hour writes 2×, reads 0.1×** base input
(0.025×–0.05× on the newest models); minimum cacheable prefix 512–4,096 tokens by
model, below which nothing is cached and no error is returned; 20-block lookback, up
to 4 breakpoints. A breakpoint on a block that changes every request writes every
time and never reads — the documented common mistake. The decisive line for an
orchestrator: **"a cache entry only becomes available after the first response
starts. If you need cache hits for parallel requests, wait for the first response
before sending subsequent requests."** Effort and thinking configuration are
rendered into the prompt, so changing top-level effort can invalidate messages
(sometimes tools and system too), while per-message effort preserves the cache;
`max_tokens: 0` pre-warms a prefix and bills only the write.

OpenAI ([docs](https://developers.openai.com/api/docs/guides/prompt-caching)):
implicit by default, explicit breakpoints on newer models, minimum 1,024 tokens on
GPT-5.6+; 30-minute writes 1.25×, 12-hour writes 2.5×, reads 0.1× (0.05× on some
models). One write plus nine reads costs **2.15×** a single uncached pass against
10×. A break-even prefix length exists, so padding up to the minimum can be cheaper
(the doc gives the formula and a worked ~221-token example). Cache lives on
individual machines; above roughly 15 requests/minute per key routing can miss, and
`prompt_cache_key` groups requests that share a prefix. Compaction, `text.format`
and effort changes reset reuse from the first changed token, though append-only
mechanisms exist. The economics are lopsided enough that a 10–20% hit-rate
difference is worth more than most routing tuning; PandaCode only sees the numbers
after the fact.

**2.2 What an orchestrator can control.**

| Lever | Reality |
| --- | --- |
| `cache_control` placement | Inside the harness; not controllable |
| Appended system instructions (`providers.rs`) | Controllable, already byte-stable — keep it so |
| Resumption vs replaying a transcript | Controllable; recovery already prefers native resumption |
| Fan-out ordering and stagger | Controllable at dispatch |
| Prefix sharing between workers | Partly: same repo, harness, model, instructions |
| Observability | `usage_ledger` already separates read/write/1h writes |

Two exploitable paths. **Warm up, then fan out:** the concurrency note means N
simultaneous identical-prefix workers guarantee N writes and zero reads; launching
the first, waiting for its first assistant delta (already a streamed event), then
releasing the rest converts most writes to reads — on a 20k-token prefix, one write
at 1.25× and N−1 reads at 0.1× instead of N writes. **Cluster, don't stripe:** keep
parallel assignments sharing a (harness, model, repo, instructions) tuple in one
wave; the team catalog is currently round-robin across harnesses
(`docs/model-routing.md`), exactly the wrong order for cache sharing.

**2.3 Proposal — cache-aware dispatch.** Add a prefix key per assignment (harness,
model, repo path, hash of the instruction block, effort level). Within a wave, group
by key; for groups larger than one, release the first launch, wait for its first
streamed delta (bounded, e.g. 20 s), then release the rest, never delaying a
single-member group, and report the choice in the dispatch note. Measure with the
ledger: cache-read share of input per harness and wave. **Acceptance:** read share
rises with no change in check-failure rate; otherwise revert rather than keeping the
latency. **Cost:** M — scheduler logic in Rust (`architect/`), no new network. Risk:
the wait adds latency and some harnesses emit no early delta; make it per-harness
skippable.

## 3. Structured and constrained decoding

**What.** Constrain generation to a JSON Schema or grammar so output is valid by
construction, with refusals distinguishable from malformed output.

**Evidence.** OpenAI Structured Outputs
([docs](https://developers.openai.com/api/docs/guides/structured-outputs),
production since GPT-4o): schema adherence for supported JSON Schema, strict mode
requiring `additionalProperties: false` and all fields required, and "explicit
refusals … programmatically detectable". The docs are careful that this removes
*format* failures, not semantic ones: "your application still needs to validate any
business rules the schema does not express." Anthropic offers strict tool use;
llama.cpp and ONNX Runtime offer grammar-constrained decoding locally.

**Why it matters here.** Three places with different maturity: own MCP tools already
take structured args, so validate and return a machine-readable error rather than a
stringly-typed one; worker reports are prose today, so a canonical extraction
(`files[]`, `checks[]`, `blockers[]`, `summary`) with schema validation and **one**
repair retry makes the board and the ledger reliable without asking harnesses for
JSON; and anything PandaCode runs itself can use constrained decoding natively. Do
not assume a harness honours a schema because its model supports one — the CLI owns
the request.

**Proposal — provider-agnostic normalisation.** One module takes arbitrary worker
text plus a schema, extracts the largest JSON object, validates, applies a single
bounded repair (fill missing keys from headings, coerce numeric strings), and
returns `{ok, value, errors, repaired}`. Use it for worker reports first, then
imported config (skills/rules) where providers differ. **Acceptance:** on ~100 real
saved worker reports (already local in SQLite), parse failure below 2% and no
report's extracted file list differs from a hand-labelled set by more than one file.
**Cost:** S/M — TS parsing, optional Rust validation; local.

## 4. Reasoning effort and thinking budgets

**Evidence.** Anthropic's [effort docs](https://platform.claude.com/docs/en/build-with-claude/effort)
(production): five levels `low`…`max`; effort affects *all* output tokens including
tool calls; `low` is recommended for subagents; `max` is "often for only a small
gain" and "on some structured-output or less intelligence-sensitive tasks it can
lead to overthinking"; changing top-level effort can invalidate the cache,
per-message effort preserves it. *The Illusion of Thinking*
([arXiv 2506.06941](https://arxiv.org/abs/2506.06941), NeurIPS 2025) finds three
regimes — standard models beat reasoning models at low complexity, reasoning helps
in the middle, both collapse at high complexity — and effort rising with complexity
**then declining despite remaining token budget**. *Does Thinking More Always Help?*
(NeurIPS 2025,
[paper](https://proceedings.neurips.cc/paper_files/paper/2025/file/fc067ac218430c409d6f65403328f740-Paper-Conference.pdf))
shows performance is not monotonic in tokens with no reliable stopping criterion, so
extending one trace is not an optimal use of test-time compute.

**Why it matters here.** `architect/model_efforts.rs` already *fits* a requested
level to the catalog and relaunches once on refusal, better than most products. The
gap is that no one *chooses* the level from difficulty or cost mode, so a Cheap team
still inherits the lead's or profile's level.

**Proposal — effort as a routing axis.** Derive a starting level from the difficulty
quantile and mode: Cheap → `low`/`medium`; Balanced → `medium`/`high` by difficulty;
Best → the model's default. Escalate effort *before* model when the failure looks
like shallow reasoning (tool loops, skipped checks) rather than capability —
`replaceReason` already carries the failed check, so the distinction is available.
Prefer per-message effort where supported to keep the cache; a top-level change is
acceptable only at a turn boundary. **Acceptance:** replay on stored outcomes shows
the same check-pass rate at ≥10% fewer output tokens on Cheap, or a higher pass rate
at equal tokens on Best. Flag per-harness — Anthropic says explicitly to run a fresh
effort sweep rather than porting settings. **Cost:** S/M — a policy field in
`panda_router/policy.rs` plus routing plumbing; keep the refusal relaunch as the
safety net because harness effort semantics differ.

## 5. Speculative decoding (indirect only)

A small draft model proposes tokens; the target verifies them in one pass.
Leviathan et al. ([arXiv 2211.17192](https://arxiv.org/abs/2211.17192), ICML 2023
oral) report 2–3× faster decoding on T5-XXL with **identical outputs**, no
retraining. It matters to PandaCode only if the local auxiliary tier grows from
classification to generation (commit messages, summaries) via llama.cpp, which
supports draft models. **Speculative for PandaCode**; do not build now. Cost: L,
local.

## 6. Quantisation for local auxiliary models

Dettmers & Zettlemoyer ([arXiv 2212.09720](https://arxiv.org/abs/2212.09720),
NeurIPS 2023) run 35,000+ experiments from 19M to 176B parameters and find **4-bit
precision almost universally optimal** for the total-bits/zero-shot-accuracy
trade-off, with small quantisation blocks and the data type the only real
improvements. The profiler is already int8 with a SHA-256-pinned download and a
parity gate (`PANDA_ROUTER_STRICT=1`, 1e-4 against the Python reference; int8 varies
slightly by CPU) — the right pattern. If a small *generative* local model is added,
prefer Q4-class GGUF over fp16 at the same memory budget and gate it the same way:
same task set, int8/Q4 versus fp16, accept only if the downstream metric moves less
than a pre-set epsilon. Cost: S to adopt, M to evaluate honestly.

## 7. Small local models as infrastructure

MTEB ([blog](https://huggingface.co/blog/mteb),
[paper](https://arxiv.org/abs/2210.07316)) covers 56 datasets and 8 task types;
small models such as `all-MiniLM-L6-v2` sit in the "speed and performance" band, and
Ettin's paired encoders/decoders were designed for this size class — PandaCode
already ships Ettin-32M. BEIR
([arXiv 2104.08663](https://arxiv.org/abs/2104.08663), NeurIPS 2021) finds **BM25 a
robust baseline** and reranking/late interaction best zero-shot "however, at high
computational costs", with dense retrieval alone often underperforming BM25 out of
domain. The shape for code search follows: lexical retrieval plus a small reranker,
not a dense index alone.

`ort` is already linked (`panda_router/onnx.rs`) with a working download/verify path
(`model_routing.rs`), so a second 30–100 MB model is incremental, not new
infrastructure. Candidates ranked by evidence strength: rerank file/symbol search
(strong); embed thread summaries and commit subjects for local search (medium);
draft commit messages (weak — no benchmark supports a quality claim and the value is
speed/privacy; **speculative**); router-fallback classification (already the
profiler's job — do not duplicate).

**Proposal — hybrid code search.** Keep the lexical scan, add an optional local
embedding index over file and symbol summaries, fuse with reciprocal-rank fusion,
then rerank the top 50 with a small cross-encoder if it fits the download budget.
**Acceptance:** nDCG@10 on a 100-query local fixture (hand-labelled "right file")
beats lexical-only by ≥10% relative at ≤50 ms p95 added latency on the reference
machine; if not, drop the reranker and keep the fusion. **Cost:** M — model download
UX, index storage, incremental invalidation on file change; Rust, local.

## 8. Tool and agent protocol evolution

**MCP.** The [2025-06-18 specification](https://modelcontextprotocol.io/specification/2025-06-18)
is JSON-RPC 2.0 over stateful connections with capability negotiation; servers offer
resources, prompts and tools, clients offer sampling, roots and elicitation. It is
the de facto tool plane and PandaCode already consumes it through harnesses
(`capabilities.rs` inventories MCP servers, sanitised). **A2A**
([1.0.0](https://a2a-protocol.org/latest/specification/)) defines AgentCard
discovery, a Task lifecycle with terminal and interrupted states, Artifacts, SSE
streaming, push notifications and JSON-RPC/gRPC/HTTP bindings for "opaque" agents
that do not share internal state; it joined the Agentic AI Foundation in 2026, the
strongest adoption signal for a protocol this young.

An orchestrator should support MCP as the *tool* boundary (already true). For A2A,
the useful subset is discovery plus task submission: an `AgentCard` is close enough
to a worker profile that ingesting one as a routable profile is cheap, and the tier
code already builds synthetic cards for unrated models; a full server is not
justified yet. **Proposal — read-only A2A client:** fetch an AgentCard, map `skills`
and `defaultInputModes` onto a synthetic card, dispatch one Task per assignment.
Marked **watch**, not build: no user has asked, and `dispatch_workers` suits local
workers better. Cost: M client, L server.

## 9. Context-window management at the boundary

Chroma's *Context Rot* ([report](https://research.trychroma.com/context-rot), July
2025) evaluates 18 models and finds performance degrading non-uniformly as input
length grows even with task difficulty held constant; distractors compound it;
focused prompts of ~300 tokens substantially beat 113k-token histories containing
the same answer. Providers now ship compaction and context-editing APIs, and both
warn that compaction resets cache reuse from the first changed token.

PandaCode's context controls are display-only (usage is a "last reported snapshot",
token saver adds prompt guidance, recovery handoff is capped at 200 messages / 64
KiB), and routing has a long-context flag with no *action* attached. **Proposal —
plan context before dispatch, not during.** When the profiler flags long context,
prefer a card whose window covers the estimate with headroom and attach a compaction
instruction to the assignment rather than letting the harness compact mid-run:
compacting before the first turn keeps the prefix stable, compacting after tool
calls destroys it. In recovery, structure the handoff (goal, decisions, files, open
questions) instead of truncating by message count — the same evidence as "focused
vs full" in LongMemEval. **Acceptance:** check-pass rate after a handoff does not
drop and median handoff tokens fall; the long-context flag stops producing
overflow-attributed harness failures. **Cost:** S/M in `architect/` and
`providers.rs`; no network.

## 10. Rate limits, backoff and quota-aware scheduling

The AWS Builders' Library,
[Timeouts, retries and backoff with jitter](https://builder.aws.com/content/3EumjoZascWd1oZiEgL8ORlv3qE/timeouts-retries-and-backoff-with-jitter)
(2019, production practice) is blunt: retries are "selfish" and amplify overload;
use capped exponential backoff **with jitter** so failed clients do not retry in
lockstep; retry at a single layer (three retries at five layers is 243× load);
prefer a token bucket to a circuit breaker; only retry idempotent calls.

`model_health.rs` already doubles pauses to a 2-hour cap and treats two paused
models on one harness as a harness pause. Missing is *cross-worker* coordination:
when N parallel workers on one harness fail at once, each backs off on its own clock
and they collide again. `agent_usage` already honours `Retry-After` for Claude
limits, but that knowledge never reaches the scheduler. **Proposal:** (1) jittered, shared
backoff derived from the shared health record, not per worker; (2) quota-aware
placement that reads the *cached* usage snapshot (60 s cached, no new network) and
avoids starting a long worker on a harness in the last 10% of a window — opt-in, and
never triggering a new read, since the privacy doc is explicit that checks run only
when the panel opens; (3) a single retry point, so the worker layer does not also
retry around the lead's `replaces` and amplification stays at 1. **Acceptance:**
after a simulated simultaneous failure of K workers on one harness, launches in the
next 60 s are spread (no burst above a threshold) and failed attempts per assignment
do not increase. **Cost:** S; local.

## 11. Offline evaluation of routing decisions

Covered structurally in §1.5, but worth stating separately because it is the only
way to improve routing without telemetry. **Counterfactual logging** requires
logging the *decision inputs* (profile, candidate set, P and bounds, mode), not just
the choice, so replay can evaluate alternative policies offline. **Bandit feedback**
(arXiv 2506.17670) makes the online half safe: explore in a bounded slot, exploit
otherwise. **Privacy:** all of it is local SQLite, so the README privacy table gains
no row; store a profile hash rather than prompt text, keeping the table as
uninteresting as `usage-ledger-cache.json`. **Proposal:** `routing_outcomes` plus a
`--replay` developer command printing Brier/NLL, escalation rate and mean cost for
two policies over the same rows. **Acceptance:** replay reproduces the live policy's
decisions exactly under the same parameters (a determinism test), and a candidate
change shows a pre-registered improvement before shipping. Cost: S/M.

## Ranked shortlist

| # | Upgrade | Confidence | Why it ranks here |
| --- | --- | --- | --- |
| 1 | Outcome ledger + replay, then bounded bandit calibration (§1.5, §11) | High | The frozen head is the binding constraint; online-routing evidence is strong; fully local, and it unlocks honest evaluation of everything else |
| 2 | Cache-aware fan-out: group by prefix, warm one, release the rest (§2.3) | Medium-high | First-party concurrency rule and 10× price gap; cheap to try, measurable in the existing ledger |
| 3 | Effort chosen from difficulty and mode, escalating effort before model (§4) | Medium-high | Effort fitting already exists; the step is small; provider docs and the overthinking literature agree on diminishing returns |
| 4 | Canonical worker-report normalisation with schema validation and one repair (§3) | Medium | Low risk, immediate reliability gain for the board and the ledger, no harness cooperation needed |
| 5 | Hybrid lexical + local embedding/rerank code search (§7) | Medium | Strong IR evidence and `ort` already shipped, but a new model download and an index are real work |

## Rejected or already covered

- **Hosted router (Martian/Unify-style).** Breaks local-first and adds a network
  dependency; RouteLLM's own routers matched commercial ones while being >40% cheaper.
- **A router trained from scratch on local data.** RouteLLM's MMLU result shows how
  badly routers generalise without in-domain labels, and one user generates too few;
  calibrate the existing head instead.
- **Speculative decoding.** Not applicable today — PandaCode does not serve
  generation. Revisit only if local generation arrives.
- **4-bit quantisation of the profiler.** Already int8 with a parity gate; 4-bit
  would trade measured accuracy for a 31 MB download that is not a problem.
- **A full A2A server.** Premature; `dispatch_workers` is a better local protocol.
  A read-only AgentCard client is the only piece worth tracking.
- **Constrained decoding on harness output.** Impossible at the API boundary —
  PandaCode does not build the request; post-hoc validation and repair is the option,
  which is why §3 proposes that.
- **Already covered, do not re-propose:** routing, ladders, health pausing, account
  pooling, usage/cache accounting, token saver, effort *fitting*, tier blend,
  exclusions, failover.

## Sources

- [RouteLLM](https://arxiv.org/abs/2406.18665) · [LMSYS write-up](https://www.lmsys.org/blog/2024-07-01-routellm/) · [FrugalGPT](https://arxiv.org/abs/2305.05176)
- [Contextual-bandit multi-LLM selection](https://arxiv.org/abs/2506.17670) · [Routing from bandit feedback](https://arxiv.org/abs/2510.07429)
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) · [Anthropic effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) · [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [The Illusion of Thinking](https://arxiv.org/abs/2506.06941) · [Does Thinking More Always Help?](https://proceedings.neurips.cc/paper_files/paper/2025/file/fc067ac218430c409d6f65403328f740-Paper-Conference.pdf)
- [Speculative Decoding](https://arxiv.org/abs/2211.17192) · [The case for 4-bit precision](https://arxiv.org/abs/2212.09720)
- [MTEB](https://huggingface.co/blog/mteb) · [BEIR](https://arxiv.org/abs/2104.08663)
- [MCP specification](https://modelcontextprotocol.io/specification/2025-06-18) · [A2A specification](https://a2a-protocol.org/latest/specification/)
- [Context Rot](https://research.trychroma.com/context-rot) · [AWS retries and backoff](https://builder.aws.com/content/3EumjoZascWd1oZiEgL8ORlv3qE/timeouts-retries-and-backoff-with-jitter)
