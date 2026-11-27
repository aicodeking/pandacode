# Context engineering and memory for coding agents

Survey for PandaCode: what is externally evidenced, what it would cost, and where it would land in this codebase.
Companion to the other files in `docs/research/ai-techniques/`. Written 2026-11-27; web sources fetched live (arXiv,
Anthropic, OpenAI, aider) — every claim below links to its source. Maturity is labelled throughout:

| Label | Meaning |
| --- | --- |
| **Shipped** | In production at a major lab, with published numbers or documented mechanics. |
| **Peer-reviewed** | Accepted at a venue (TACL, COLM, NeurIPS, ICML, ICLR, EMNLP). |
| **Preprint** | arXiv only, or vendor-authored and not independently replicated. |
| **Reproduced** | Third-party replications, or a widely copied implementation. |
| **Speculative** | Reasonable extrapolation from the above with no direct measurement. |

## 0. What PandaCode actually has today

An honest baseline first — several "new" ideas are already here, and the gap is narrower than the brief implies.

| Surface | Where | What it really does | What it does **not** do |
| --- | --- | --- | --- |
| Provider-switch handoff | `src-tauri/src/context_recovery.rs` (`HISTORY_BYTES = 64 * 1024`, `HISTORY_MESSAGES = 200`) | One-shot, newest-first, byte-budgeted replay into a single synthetic user message, with an explicit "bounded excerpt" notice and per-message shortening at a UTF-8 boundary. | Not summarised, not structured, not cached; the whole transcript becomes one message in the *middle* of the prompt. |
| Transcript windowing | `src/transcript-window.ts`, `src/transcript-rows.ts` (`MORE_TURNS`, `ROW_BUDGET`, `content-visibility`, lazy Markdown) | Rendering economy: the UI draws less. | Does nothing for the model's context. Window and context are unrelated systems; don't conflate them. |
| Token saver | `src/token-saver.ts` (`PACKS`, `REMIND_EVERY = 8`, `CONTEXT_TIGHTEN_AT = 0.75`) | Appends a response-style block at *send*, only when packs change and every 8 turns. Suffix-only, so it is cache-safe. | Advisory prose; no measurement of whether the model complied. |
| Team briefs and notes | `pandacode_team_notes`, checkpoints, `docs/architect-workers.md` (overhead budgets 4,200 B architect / 3,000 B worker; objective quoted as first 1,400 + last 600 bytes) | Per-worker isolation and a durable blackboard with paging and a "N more notes" count. | No decay, no dedupe beyond key uniqueness, no contradiction resolution, no relevance ranking. |
| Skills library | `src/skills-library.ts`, `skills_matrix`, `docs/skills-library.md` | Import, per-harness/per-scope activation, content hashes, drift detection, safety findings, quarantine. | **No injection for `prompt`-surface harnesses** ("Not yet", `docs/skills-library.md`); no learning loop; no `SKILL.md` body is ever composed into a turn for 8+ harnesses. |
| Code search | `src-tauri/src/workspace/text_search.rs`, `file_search.rs` | Bounded, ignore-aware literal/regex search; 5 s deadline, 2,000 matches; filename index with a 3 s TTL. | No symbols, no graph, no BM25 ranking, no embeddings, no rerank. Searching `src-tauri/src` for `tree_sitter`, `bm25` and `embedding` finds only a pricing-test fixture (`usage_ledger/tests.rs`), not an implementation. |
| Cache economics | `src-tauri/src/usage_ledger/pricing.rs`, `docs/agent-usage.md` | Per-turn `input`, `cache_read`, `cache_write`, `cache_write_1h`, long-context tiers; "cache savings" = read tokens × (input − cache-read) rate. | Measurement only. Nothing in the app *uses* the number to change what it sends. |

That last row matters: PandaCode already has the instrumentation any caching proposal needs for an acceptance signal.
It has no index, no summariser, and no memory service.

## A. Prompt-cache-aware prompt layout

**What it is.** Provider KV-cache reuse over an *exact* prefix. Anthropic caches `tools` → `system` → `messages` in
that hierarchy, with at most **4 explicit breakpoints**, a **20-block lookback**, and writes only *at* a breakpoint —
so a breakpoint on a block that changes every request writes a fresh entry and never reads
([Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), **Shipped**).
OpenAI caches implicitly by default (breakpoint at the latest eligible message), supports explicit breakpoints on
GPT-5.6+, and keys routing on the initial tokens plus an optional `prompt_cache_key`
([OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), **Shipped**).

**Cost maths** (both vendors, per million input tokens):

| | Write | Read | Break-even |
| --- | --- | --- | --- |
| Anthropic 5 m TTL | 1.25× | 0.1× (0.05× on newest Opus/Sonnet) | 2 of 2 calls cheaper than 2× uncached |
| Anthropic 1 h TTL | 2× | 0.1× | needs ~3+ reuses, or gaps > 5 min |
| OpenAI 30 m | 1.25× | 0.1× (0.05× on some) | write-once/read-once = 1.35× vs 2×; 10 calls = 2.15× vs 10× |
| OpenAI 12 h | 2.5× | same | stable prefixes reused across long gaps |

OpenAI's own worked example: a multi-turn agent that appends without rewriting and puts a breakpoint after each tool
result reported a **>90 % token cache-hit rate**; a single-turn judge with a stable rubric reported **~70 %**.

**What breaks caching** (the expensive part). From Anthropic's invalidation table: changing **tool definitions**
invalidates everything; toggling web search, citations, or speed invalidates system and messages; `tool_choice`,
**images anywhere**, thinking parameters, and `output_config.effort` invalidate messages and sometimes more; dropping
un-preserved thinking blocks invalidates from that block on. Unstable JSON key order (Swift, Go) breaks it too. OpenAI
adds: `model`, `tools` ordering/schemas, `parallel_tool_calls`, `text.format`, `verbosity`, and — critically —
**compaction and summarisation**, which "replac[e] earlier conversation content … from the first changed token onward."

**Why it fits PandaCode.** Two surfaces, and one of them is a real hazard:

1. *Hazard*: `context_recovery::prepare` collapses the entire transcript into one synthetic user message at switch
   time. That is a guaranteed full miss, and it is paid again any time the recovery is retried.
2. *Hazard*: team turns that re-render the objective ("first 1,400 + last 600 bytes") or re-send full rules every
   eighth turn rewrite text *behind* the new content. `docs/architect-workers.md` is explicit that later turns get a
   one-line reminder — good — but the eighth-turn full-rules reset is a deliberate cache sacrifice worth naming.
3. *Fit*: the token-saver block and skill reminders are appended at the tail. That is the correct shape; it should be
   documented as a constraint so nobody "improves" it by moving guidance into the system prompt per turn.

Caveat worth stating plainly: for most harnesses PandaCode spawns a CLI and does **not** build the API request. Cache
layout there is the harness's job. PandaCode controls layout only in (a) the handoff/recovery prompt, (b) the
appended tail blocks, (c) team briefs and internal coordination turns, and (d) any prompt it sends through a provider
it drives directly.

**Cost & complexity.** **S–M**, TypeScript (assembly) + Rust (telemetry aggregation). Local only.

**Proposal.** Add a `context_assembly` module that emits an ordered, tagged prompt skeleton — `[stable tools] →
[stable system] → [project guidance] → [summary state block] → [recency tail] → [turn-specific suffix]` — with
breakpoint hints at each boundary, plus a small report (`stable_prefix_bytes`, `rewritten_prefix_bytes`,
`expected_hit`) surfaced beside the existing cache-savings line. Make `context_recovery` emit that skeleton instead of
one blob. **Acceptance signal:** on Claude and Codex threads, the `cache_read / (cache_read + input)` share recorded
by `usage_ledger` rises for threads that switched harness or resumed, with no drop in cache write efficiency; any
turn whose assembly rewrites prefix bytes is flagged in the report.

## B. Compaction and structured state

**What it is.** Summarise-then-continue, hierarchical summaries, or a maintained state document, so a long thread
keeps working past the window.

**Evidence.**
- Anthropic documents the mechanics and the failure mode: compaction "distills the contents of a context window,"
  Claude Code keeps architectural decisions, unresolved bugs and implementation details, and re-seeds "the five most
  recently accessed files"; over-aggressive compaction "can result in the loss of subtle but critical context whose
  importance only becomes apparent later" ([Effective context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents), **Shipped**).
- Measured, with numbers: tool-result clearing alone gave **+29 %** on an internal agentic-search eval; memory tool +
  context editing gave **+39 %**; a 100-turn web-search run cut token consumption by **84 %**
  ([Managing context](https://claude.com/resources/articles/context-management), **Shipped**, vendor eval set).
- **ACON** compresses history *and* observations, refining compression guidelines from the agent's own failure
  analysis: **26–54 %** lower peak tokens and up to **+46 %** task success for smaller models on AppWorld,
  OfficeBench, Multi-objective QA ([arXiv:2510.00615](https://arxiv.org/abs/2510.00615), **Peer-reviewed**, ICML 2026).
- Anthropic's long-running-agent work adds the uncomfortable finding: **compaction alone is not enough.** A frontier
  model in a loop still half-implements features and lets the next session guess; the fix was an initializer agent,
  a `claude-progress.txt`, a JSON feature list, and git commits as the durable artefact
  ([Effective harnesses](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents), **Shipped**).
  JSON over Markdown specifically because the model edits status fields rather than rewriting prose.

**Why it fits PandaCode.** `context_recovery` is the closest thing to compaction and it is deliberately lossy in the
wrong dimension: it truncates long *messages* first, so one large tool output is shortened while a stale decision can
survive intact. Also, the handoff is a single user message, which puts the whole history in the middle of the prompt —
exactly where recall is worst (see §C).

**Cost & complexity.** **M–L**, Rust for the deterministic part (state extraction from `turn_changes`, checkpoints,
unresolved errors); the summariser itself should be the *user's own harness*, never a PandaCode-paid call. Local.

**Proposal.** Introduce a per-thread `state.md`-equivalent row — a structured block with `decisions`, `unresolved`,
`next_step`, `files_touched`, `open_questions` — updated from data PandaCode already records (`turn_changes`,
`checkpoint_worker`, `pandacode_team_notes`), and rebuild `context_recovery` as `[state block] + [last K turns verbatim]
+ [older, one-line-per-turn digest]` rather than a 200-message byte-budgeted blob. **Acceptance signal:** on a
replayed fixture transcript, references like "this", "that file" and "the failing test" resolve after a forced
harness switch in ≥ 9 of 10 scripted probes, versus a recorded baseline for today's handoff; handoff prompt size
falls without an increase in re-asked questions (measurable from repeat user turns within the first three turns).

## C. Long context vs retrieval

**What it is.** Whether to stuff the window or retrieve into it.

**Evidence, and it is not ambiguous.**
- **Lost in the Middle** (TACL 2023): performance is highest when relevant information is at the beginning or end and
  "degrades significantly when models must access relevant information in the middle," *even for explicitly
  long-context models* ([arXiv:2307.03172](https://arxiv.org/abs/2307.03172), **Peer-reviewed**).
- **RULER** (COLM 2024): 17 long-context models, 13 tasks. "Despite achieving nearly perfect accuracy in the vanilla
  NIAH test, almost all models exhibit large performance drops as context length increases"; of models claiming
  ≥ 32 K, **only half** held up at 32 K ([arXiv:2404.06654](https://arxiv.org/abs/2404.06654), **Peer-reviewed**).
- **Context Rot** (Chroma, July 2025): 18 frontier models, 194,480 calls, task complexity held constant while only
  input length varied. **Every** model degraded with length; lower needle–question similarity degraded faster; one
  distractor already hurt and four compounded it; on LongMemEval, focused ~300-token prompts beat full ~113 k-token
  prompts across every family. A structural surprise worth remembering: **shuffled haystacks scored *better* than
  coherent ones** ([Context Rot](https://www.trychroma.com/research/context-rot), **Reproduced** — code released).
- Counterweight, from the vendor that benefits: if your corpus is **under ~200 k tokens, just put it in the prompt**,
  made affordable by caching ([Contextual Retrieval](https://www.anthropic.com/research/contextual-retrieval), **Shipped**).

**Why it fits PandaCode.** A mid-size repo's `AGENTS.md`, rules, skills and recent diffs fit comfortably in the
"just include it" band; a monorepo does not. And PandaCode's 64 KiB handoff is already an admission that the window
is a budget, not a container. The practical rule: **stable, small, always-relevant → include; large or uncertain →
retrieve just-in-time**, which is exactly the hybrid Anthropic describes (CLAUDE.md up front, glob/grep on demand).

**Cost & complexity.** **S** to adopt as policy (mostly deletion of ambition), **L** if it justifies an index (§F).

**Proposal.** Codify the policy in the assembly module: a hard budget for always-included guidance (say 8–12 k
tokens), everything else retrieved. Put the *most decision-relevant* state at the **end** of the prompt, immediately
before the ask, and never rely on the middle of a long block. **Acceptance signal:** a scripted eval over the repo
where the answer lives in the middle of a long included file (a "needle in the middle" probe) improves after moving
that file behind a retrieval step, with no regression on always-included guidance tasks.

## D. Agentic memory systems

**What it is.** Persistent memory outside the window, with read/write policy.

| System | Mechanism | Evidence | Maturity |
| --- | --- | --- | --- |
| **MemGPT / Letta** | OS-style paging between main context and external store; the model calls memory tools | ([arXiv:2310.08560](https://arxiv.org/abs/2310.08560)) | **Preprint**, widely built on; needs a resident agent loop |
| **Zep / Graphiti** | Temporally-aware knowledge graph; edges carry validity intervals | DMR 94.8 % vs MemGPT 93.4 %; LongMemEval up to **+18.5 %** accuracy, **−90 %** latency ([arXiv:2501.13956](https://arxiv.org/abs/2501.13956)) | **Preprint**, vendor-authored; not independently replicated at scale |
| **Mem0** | Extraction + update pipeline over a vector store, optional graph | **26 %** relative LLM-judge gain over OpenAI memory, **91 %** lower p95 latency, **>90 %** token savings ([arXiv:2504.19413](https://arxiv.org/abs/2504.19413)) | **Preprint**, vendor-authored |
| **LangMem** | Library of memory tools over a store | No independent benchmark | **Speculative** as evidence |
| **A-MEM** | Zettelkasten-style linked notes with evolving attributes | Small-scale result | **Preprint** |

Read those vendor numbers with the usual discount: each is measured on the authors' own harness, with an LLM judge,
against a baseline the authors chose. The *direction* is credible — externalised, deduplicated memory beats replaying
transcripts — but the *magnitudes* are not transferable to a coding agent.

**Why it fits PandaCode — and where it doesn't.** PandaCode cannot adopt MemGPT's loop: it does not own the
tool-calling loop, and a resident memory service would violate the no-resident-server rule. What it *can* adopt is the
**write policy**, applied to `pandacode_team_notes` and checkpoints, which today accept any key/value with no decay
and no contradiction handling.

**Cost & complexity.** **M**, Rust + SQLite. Local. No network.

**Proposal.** Turn team notes into a scoped memory table: `(project, scope, key, value, provenance, created_at,
last_used_at, confidence, supersedes)`, with (i) **dedupe** on normalised key, (ii) **decay** by `last_used_at`
demoting rather than deleting, (iii) **contradiction handling** — a newer write marks the older row `superseded`
instead of overwriting silently, so a turn can see that a decision changed, and (iv) briefs rank by
`recency × use_count` inside the existing byte budget instead of "newest N". **Acceptance signal:** on a project with
a deliberately reversed decision (A, then later not-A), an agent asked about it reports the current decision and does
not cite the stale one, in ≥ 9 of 10 probes; brief size stays within today's 4,200 B / 3,000 B budgets.

## E. Procedural memory: skill libraries learnt from experience

**What it is.** Memory of *how*, not *what*: reusable, named procedures.

**Evidence.**
- **Voyager** (NeurIPS 2023): an ever-growing library of **executable code** skills, retrieved by embedding, with an
  automatic curriculum. **3.3×** more unique items, **2.3×** travel distance, tech-tree milestones up to **15.3×**
  faster; the library transferred to a fresh world to solve novel tasks
  ([arXiv:2305.16291](https://arxiv.org/abs/2305.16291), **Peer-reviewed**). The transfer result is the interesting
  one — skills composed, they did not just accumulate.
- **ACE (Agentic Context Engineering)** (ICLR 2026): treat context as an evolving **playbook**, updated by
  Generator/Reflector/Curator with *structured incremental* edits. It names the two failure modes of naive learning —
  **brevity bias** (summaries drop domain insight) and **context collapse** (iterative rewriting erodes detail over
  time). Results: **+10.6 %** on agents, **+8.6 %** on finance, and on the AppWorld leaderboard it matches the
  top production agent overall and beats it on the harder test-challenge split, with a smaller open model
  ([arXiv:2510.04618](https://arxiv.org/abs/2510.04618), **Peer-reviewed**). ACE is the strongest evidence in this
  document that *append-and-curate beats rewrite*.

**Why it fits PandaCode.** The machinery is already installed and half-empty. `skills_matrix` knows every skill, its
harness, its scope, its hashes and whether it has drifted; `docs/skills-library.md` lists "version diffs with
promote/skip/pin" and "conflict detection between rules" as not-yet; and skills are **not injected at all** for
`prompt`-surface harnesses. So PandaCode has a curated library, a compatibility matrix, and no way for the library to
learn from a turn that went well.

**Cost & complexity.** **M** for injection, **L** for the learning loop. Rust (extraction, diffing, gating) +
TypeScript (review UI). Local.

**Proposal, two stages.** (1) *Ship the missing plumbing*: compose `SKILL.md` bodies (name + description first,
body on demand — Anthropic's own progressive-disclosure guidance) into turns for `prompt` harnesses, honouring the
existing switch and drift state. (2) *Add a gated candidate loop*: after a turn that passed checks with no retries,
extract a candidate procedure (trigger, steps, files, verification) into the library as `draft`, never auto-active;
promote only on a human click, with the safety scan (`skills/safety.rs`) and drift matrix already in place.
**Acceptance signal:** stage 1 — a skill switched on for a `prompt`-surface harness is demonstrably present in the
turn's composed prompt (fixture assertion) and off-skills are absent; stage 2 — over 20 completed turns, ≥ 3 drafts a
reviewer accepts as genuinely reusable and ≤ 1 is rejected as a restatement of the diff.

## F. Repo-level context: maps, graphs, hybrid retrieval

**What it is.** Giving the agent the shape of the repo cheaply, and fetching the right code on demand.

**Evidence.**
- **aider's repo map** (**Shipped**, widely copied): tree-sitter extracts definitions and references; a graph with one
  node per file and edges for dependencies is **PageRank**-ranked; the top-ranked symbols are emitted to fit
  `--map-tokens` (default **1 k**). The stated benefit is that the model can then *ask* for the files it wants. This is
  the single most cost-effective repo-context technique in production today
  ([aider repo map](https://aider.chat/2023/10/22/repomap.html)).
- **Contextual Retrieval** (**Shipped**): prepending a 50–100-token chunk-specific context before embedding *and*
  before building BM25 cuts top-20 retrieval failure **35 %** (5.7 → 3.7 %); contextual embeddings + contextual BM25
  cuts it **49 %** (→ 2.9 %); adding a reranker cuts it **67 %** (→ 1.9 %). Embeddings alone are worse than
  embeddings + BM25; top-20 chunks beat top-10 and top-5
  ([Contextual Retrieval](https://www.anthropic.com/research/contextual-retrieval)).
- **CodeRAG** (EMNLP 2025): for repository-level completion, multi-path retrieval (sparse, dense, dataflow) plus a
  preference-aligned reranker beats single-path retrieval on ReccEval and CCEval
  ([arXiv:2509.16112](https://arxiv.org/abs/2509.16112), **Peer-reviewed**).
- **ColBERT** late interaction (**Reproduced**, since 2020): token-level embeddings with a cheap MaxSim, cacheable
  document vectors — the practical middle ground between a bi-encoder and a cross-encoder
  ([arXiv:2004.12832](https://arxiv.org/abs/2004.12832)).

**Why it fits PandaCode.** `text_search.rs` is a careful *literal* searcher — no ranking beyond "matched", no symbols,
and a hard 2,000-match cap that a `grep` for `useState` fills instantly. There is no way today to ask "where is
`refresh()` defined and who calls it". The surface is empty, the primitives are not: SQLite already ships FTS5, and
`file_search.rs` proves the walk + ignore + cache pattern.

**Cost & complexity.** **M** for symbols + FTS5 + PageRank; **L** for embeddings and a reranker. Rust. Local; ONNX
model download is opt-in and cached, which is the only network touch and must be declared.

**Proposal.** A local `code_index` in SQLite: `symbols(path, kind, name, signature, start, end, lang)` from
tree-sitter, an FTS5 BM25 table over chunked bodies (chunked on AST node boundaries, not fixed windows — that is what
Contextual Retrieval's "chunk boundaries matter" note is about), and a PageRank score per file over an import graph.
Expose one tool: `search_code(query, budget)` returning ranked symbols *with* signatures and a path, so the agent can
decide what to open — teach the agent to retrieve, don't pre-stuff its window. Add embeddings only after BM25 +
PageRank has been measured. **Acceptance signal:** on 50 real questions of the form "where is X / who calls Y",
top-5 contains the true definition or call site for ≥ 80 % of queries, with index build < 60 s on this repo and
incremental update < 200 ms for a one-file change; and a turn that answers such a question does fewer file reads than
today (counted from the transcript).

## G. Local embeddings and rerankers

**What it is.** Semantic search without a network or an API bill.

**Evidence.** `fastembed-rs` (**Shipped**, actively maintained) runs ONNX locally and covers exactly the shapes §F
needs: dense (BGE small default), sparse SPLADE, **BGE-M3 dense + sparse + ColBERT in one pass**, and cross-encoder
`TextRerank` ([fastembed-rs](https://github.com/anush008/fastembed-rs)). The 49 % → 67 % gap in Contextual Retrieval is
the reranker's value, and both a cross-encoder and a ColBERT-style late-interaction model can now run on-device. The
*quality* claims for these models come from their own papers and BEIR-family benchmarks; PandaCode should re-measure
on its own code, because code is not prose and embedding benchmarks are dominated by natural-language QA.

**Why it fits PandaCode.** It keeps the local-first promise: no traffic, no accounts, no phone-home. It costs an
opt-in model download and a resident ~50–200 MB memory footprint during indexing only.

**Cost & complexity.** **M**, Rust, `ort`/ONNX. Local; model fetch is the one network event, behind the existing
opt-in pattern.

**Proposal.** Ship dense + rerank **behind a flag**, off by default, and only after §F's BM25 baseline is measured, so
the marginal value is attributable. **Acceptance signal:** adding embeddings and then a reranker improves the §F
top-5 hit rate by a stated margin (and the reranker by a further margin) on the same 50-question set; index size and
cold-start latency stay inside declared budgets; with the flag off, zero network requests at launch (asserted by test).

## H. Memory-write policy

**What it is.** The unglamorous part: what to store, what to merge, what to forget, what to distrust.

Consolidated from the systems above, the defensible rules are:

- **Write only what the next shift cannot re-derive.** Decisions, invariants, gotchas, verification commands.
  Everything else is re-readable from the repo — and re-reading is cheaper than a stale copy (Anthropic's
  "just-in-time" argument, §C).
- **Append and curate; never rewrite wholesale.** ACE's "context collapse" is the failure you get from rewriting.
- **Provenance always.** `pandacode_team_notes` already binds agent identity host-side; memory rows should carry
  turn and file provenance so a wrong memory is traceable and revocable.
- **Contradictions are events, not overwrites.** A superseding row plus a validity interval (Zep's core insight) beats
  silent replacement, and it is cheap in SQLite.
- **Decay is demotion, not deletion.** Recency × use-count ranking inside a fixed byte budget; hard-delete only on
  explicit user action. This keeps the existing "N more notes" behaviour honest.
- **Never let memory carry instructions.** Worker output is data, not commands — the existing team guard already says
  this; memory rows must be length-bounded and rendered as quoted data, not as guidance.

**Why it fits PandaCode.** All of it lands in existing tables and existing caps. **Cost S–M**, Rust. Local.

## I. File-based memory: AGENTS.md layering and how to stop the bloat

**What it is.** Project guidance in files the agent reads: `AGENTS.md` (the open format, reportedly used by 60 k+
open-source projects — [agents.md](https://agents.md/), **Shipped/ecosystem**), `CLAUDE.md`, nested per-directory
files, and progressive disclosure via a short index plus loadable detail.

**Evidence.** Anthropic's guidance is explicit about the mechanism: the smallest set of high-signal tokens, organised
into distinct sections, with `CLAUDE.md` dropped in up front and everything else fetched just-in-time; and it warns
against "a laundry list of edge cases" ([Effective context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)).
The bloat failure is structural, not a matter of taste: every always-included line is paid on **every** turn, and §C
shows recall does not improve with volume.

**Why it fits PandaCode.** PandaCode already writes into these files — `skills/adapter.rs` wraps its own rule blocks in
`<!-- pandacode:rule:<id> -->` markers inside `CLAUDE.md` and `AGENTS.md` — so it is already a participant in the
bloat problem, and can be the solution.

**Cost & complexity.** **S**, TypeScript (analysis) + Rust (read). Local.

**Proposal.** A guidance linter in Rules & library: report total always-included bytes per project and per harness,
flag files over a threshold, detect duplicated text between `AGENTS.md`/`CLAUDE.md`/rules/skills, and propose moving
long sections into a skill that loads on demand. Do **not** auto-edit user prose. **Acceptance signal:** for this
repo, the linter reports a stable always-included byte count and identifies at least the real duplications between
`AGENTS.md` and `docs/agent-reference.md` pointers; a reviewer agrees each flagged block is genuinely movable.

## Ranked shortlist

| # | Upgrade | Confidence | Cost | Why it ranks here |
| --- | --- | --- | --- | --- |
| 1 | **Cache-aware assembly + prefix-rewrite reporting**, replacing the single-blob `context_recovery` prompt | **High** | S–M | Shipped mechanics on both vendors, arithmetic is unambiguous, and `usage_ledger` already measures cache reads so the acceptance signal is free. |
| 2 | **Structured state block for compaction** (`decisions / unresolved / next_step / files`) instead of byte-budgeted message truncation | **Medium-High** | M | +29 % / +39 % and −84 % tokens are shipped, measured results; the "compaction alone is not enough" finding says the *state artefact*, not the summary, is the load-bearing part. |
| 3 | **Local code index**: tree-sitter symbols + FTS5 BM25 + file PageRank, exposed as one `search_code` tool | **Medium-High** | M | aider's repo map is the best cost/benefit in production; BM25 + graph is the measured core of Contextual Retrieval without any model download. |
| 4 | **Memory write policy** — dedupe, decay, supersede-on-contradiction, provenance — over team notes | **Medium** | S–M | Cheap, all inside existing tables and byte caps, and fixes a real defect (notes never decay, contradictions silently overwrite). Benefit is qualitative; measure by probe. |
| 5 | **Skill injection for `prompt` harnesses, then a gated draft loop** | **Medium** (stage 1) / **Low-Medium** (stage 2) | M / L | Voyager and ACE support the loop, but both are far from coding agents; stage 1 is a documented gap with an obvious fix and a fixture-testable signal. |

Deliberately *not* ranked above these: embeddings and rerankers (§G). They are real, but their marginal value over
BM25 + PageRank on *code* is unmeasured, and shipping them first would make attribution impossible.

## Rejected, or already covered

| Item | Verdict |
| --- | --- |
| Transcript windowing as "context management" | **Already covered, and a category error.** `transcript-window.ts` saves rendering work; it does not touch the model's context. Keep it, and stop treating it as a context feature. |
| Per-worker context isolation, briefs, bounded handoff | **Already covered** (`docs/architect-workers.md`, `context_recovery.rs`). Improve the *shape* of the handoff (§A/B), do not re-propose isolation. |
| Token saver | **Already covered**, and correctly shaped as a suffix. Fold its packs into the library eventually; do not move it into the system prompt. |
| AGENTS.md / rules import | **Already covered** (`skills/adapter.rs`, Rules & library). Add the linter (§I) rather than another import path. |
| MemGPT/Letta virtual context | **Rejected.** Needs a resident agent loop PandaCode does not own, and a service process the no-resident-server rule forbids. Take the write policy (§H), not the architecture. |
| Zep/Graphiti temporal graph as-is | **Rejected for now.** Requires LLM extraction on every ingested turn — a cost PandaCode would either pay or push onto the user — and the evidence is one vendor paper. Borrow the validity-interval idea (§H) at SQLite cost. |
| Mem0 pipeline as-is | **Rejected as a component.** Same vendor-evidence caveat plus a Python service dependency. |
| Vector database server (Chroma, Qdrant, …) | **Rejected.** Violates local-first and no-resident-server. `sqlite-vec` or ONNX in-process only. |
| Semantic response caching (GPTCache-style) | **Rejected.** For a coding agent the answer depends on repo state, so a near-miss cache hit is a wrong answer. High downside, small upside. |
| Fine-tuning or training embeddings on the repo | **Rejected.** Cost, and it breaks the "no model training" posture. |
| Hierarchical multi-level summaries (summary of summaries) | **Deferred, not rejected.** The evidence for levels beyond one is thinner than for a structured state block, and §B's artefact solves the same problem more cheaply. |

## Sources

- [Prompt caching — Claude Platform Docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Prompt caching — OpenAI API](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Effective context engineering for AI agents — Anthropic](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)
- [Managing context on the Claude Developer Platform — Anthropic](https://claude.com/resources/articles/context-management)
- [Effective harnesses for long-running agents — Anthropic](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents)
- [Contextual Retrieval — Anthropic](https://www.anthropic.com/research/contextual-retrieval)
- [Context Rot: How Increasing Input Tokens Impacts LLM Performance — Chroma](https://www.trychroma.com/research/context-rot)
- [Lost in the Middle: How Language Models Use Long Contexts — Liu et al., TACL 2023](https://arxiv.org/abs/2307.03172)
- [RULER: What's the Real Context Size of Your Long-Context Language Models? — COLM 2024](https://arxiv.org/abs/2404.06654)
- [ACON: Optimizing Context Compression for Long-horizon LLM Agents — ICML 2026](https://arxiv.org/abs/2510.00615)
- [Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models — ICLR 2026](https://arxiv.org/abs/2510.04618)
- [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560)
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956)
- [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413)
- [Voyager: An Open-Ended Embodied Agent with Large Language Models — NeurIPS 2023](https://arxiv.org/abs/2305.16291)
- [CodeRAG: Finding Relevant and Necessary Knowledge for Retrieval-Augmented Repository-Level Code Completion — EMNLP 2025](https://arxiv.org/abs/2509.16112)
- [ColBERT: Efficient and Effective Passage Search via Contextualized Late Interaction over BERT](https://arxiv.org/abs/2004.12832)
- [Building a better repository map with tree sitter — aider](https://aider.chat/2023/10/22/repomap.html)
- [fastembed-rs — local embeddings and reranking in Rust](https://github.com/anush008/fastembed-rs)
- [AGENTS.md — an open format for guiding coding agents](https://agents.md/)
