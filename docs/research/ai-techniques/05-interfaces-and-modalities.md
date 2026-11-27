# 05 · Interfaces and modalities: how agents perceive and act through UI

Research note for PandaCode. No code changes. Sources checked 2026-11-27 with web access.

Evidence tags as in `03-verification-reliability.md`: **[shipped]** (production at a major lab, documented),
**[benchmark]** (reproduced public benchmark), **[paper]** (peer-reviewed or camera-ready), **[preprint]**
(arXiv, directional), **[tooling]** (practitioner docs/blog, no controlled study). Surfaces named below are
real: `read_browser` / `browser_click` / `browser_type` / `capture_browser` (`agent_tools.rs`,
`browser_agent.js`, `browser.rs::browser_inspect`), Jev (`jev.rs`), `pandacode_vm_*` and `simulator_*`,
`src/generative-ui.ts`, `src/design-canvas.ts`, `src/progress-pip.ts`, `src/agents-dock.ts`,
`src/thread-tiles.ts`, `docs/approvals.md`, `src/voice-*.ts`, `docs/rewind.md`.

## 0. The five facts that should drive the roadmap

| # | Finding | Number | Source |
|---|---|---|---|
| 1 | Desktop UI agency is bounded by **grounding, not reasoning** | OSWorld: of 550 analysed failures, **over 75%** are mouse-click inaccuracies — plan right, pixel wrong | [OSWorld](https://arxiv.org/abs/2404.07972) **[paper]**; [analysis](https://beancount.io/bean-labs/research-logs/2026/06/15/osworld-benchmarking-multimodal-agents-real-computer-environments) **[tooling]** |
| 2 | High-precision professional grounding is still hard | ScreenSpot-Pro (23 apps, 5 industries, 3 OSes): best model at release **18.9%** | [ScreenSpot-Pro](https://arxiv.org/abs/2504.07981) **[benchmark, 2025]** |
| 3 | **Element refs beat pixel coordinates** when a tree exists | Refs "survive layout shifts and reflows"; a tree read "often costs fewer input tokens than a screenshot" | [Browser use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool) **[shipped, 2026]** |
| 4 | A **completion judge + feedback** lifts success | VLM screenshot judge: **73%** task-success detection accuracy, **+27% relative** overall task success | ["Are We Done Yet?"](https://arxiv.org/abs/2511.20067) **[paper, AAAI 2026 workshop]** |
| 5 | Agents **cannot tell they are done** | Same paper's premise: CUAs "often fail to reliably determine whether a given task has been completed" | **[paper]** |

PandaCode already owns the expensive parts — a drivable browser, a capture pipeline, a progress surface with
annotation primitives, Jev. It lacks a *standard observation format* and a *closed verification loop*.

## 1. Computer-use grounding: coordinates vs selectors vs set-of-mark

**What it is.** Three ways to name a target. *Coordinate*: click (x, y) in screenshot pixel space.
*Selector/ref*: a DOM or accessibility identity the executor resolves. *Set-of-Mark*: overlay numbered badges
on candidate regions; the model answers with a badge, the harness maps it back to a node.

**Evidence.**

- SoM was the first result showing *prompting alone* closes much of the fine-grained grounding gap
  ([arXiv:2310.11441](https://arxiv.org/abs/2310.11441)) **[paper, 2023]** — now a standard comparison arm.
  OSWorld tested screenshot-only, a11y-tree-only, both, and SoM: screenshot-only top models scored
  **5.26–5.80%** against a **72.36%** human baseline. Structured context roughly doubled success, but SoM and
  tree benefits were **model-dependent** and could *mislead* a model — SoM is a labelling discipline, not free
  accuracy **[paper]**.
- SeeAct found **textual element choice** the strongest grounding strategy, near supervised fine-tuning, with
  oracle grounding lifting step success to **~62%** ([arXiv:2401.01614](https://arxiv.org/abs/2401.01614))
  **[paper, 2024]**. "If Grounded" is the paper's thesis.
- Vendors converged: Claude's *computer* tool is coordinate-only; its *browser* tool is ref-first with
  coordinates as fallback for canvas/iframe/virtualised content, refs stay valid until navigation or material
  DOM change, and a stale ref must return an actionable error
  ([computer use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool))
  **[shipped]**. Playwright's agent CLI ships the same shape **[tooling]**.

**Why it fits PandaCode.** `browser_agent.js` returns `{selector, tag, label, type, disabled}` from a fixed
`a,button,input,textarea,select,[role=button]` query, capped at 100, with hand-built `:nth-of-type` paths up to
64 components. Three defects: no stable *handle* (paths break on re-render), no accessibility semantics
(`role`, `name`, `state`), and no non-interactive targets (canvas, custom `div` widgets). `capture_browser`
returns a bare PNG, so the model must bridge pixels and selectors alone — the 75%-failure regime.

**Cost & complexity.** M. TS in the page script (walk a11y tree, assign `ref_N`, keep the mapping in a
page-global until navigation) + Rust for the IPC contract and ref→node resolution. Local, no new dependency.

**Proposal — `read_browser` returns refs; `capture_browser` can annotate.**
1. Emit a token-bounded list of *actionable* nodes, a11y-first then DOM: `ref_7 button "Save changes" enabled`;
   keep `selector` alongside for compatibility.
2. Refs from a monotonic per-generation counter; resolve `ref_N` → stored node on click/type. If detached,
   return exactly `ref_7 is stale or not found; read the page again`, so the model re-reads instead of guessing.
3. Add `capture_browser { annotate: true }`: badge each ref at its box corner, returning PNG + ref list, so one
   image and one text block describe the same targets. Keep `browser_click { selector }`; add `{ ref }`.

**Acceptance signal.** On a fixture page with 40 widgets including a canvas chart and a re-rendering list:
every ref resolves on first click across 3 consecutive re-reads; the annotated capture's badge count equals the
ref count; an intentionally stale ref yields the error and the next read succeeds. Assert in
`tests/browser*.spec.ts` and a Rust unit test over `browser_agent.js` with a recorded frame.

## 2. What actually raises GUI-agent success rates

**What it is.** Beyond grounding, four recurring levers: action verification (look before you leap), visual
reflection with a before/after diff, a completion judge, and history management.

**Evidence.**

- Anthropic's prompting guidance is explicit: *"After each step, take a screenshot and carefully evaluate if
  you have achieved the right outcome… If it didn't, try again"*, and *"End each group of actions with a
  screenshot."* Its limitations admit the model "sometimes acts as if its actions succeeded without explicitly
  checking their results" **[shipped]**. The judge paper measures the payoff: **73%** detection accuracy,
  **+27%** relative success **[paper]**. Anthropic's harness write-up reports the same shape for coding:
  browser testing as a human would, run *at session start* to catch prior-session regressions
  ([harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)) **[tooling]**.
- ReVision: consecutive screenshots are highly redundant; a learned patch selector cuts visual tokens **46%**
  while *improving* success **3%**, and success keeps rising with more history once redundancy is removed
  ([arXiv:2605.11212](https://arxiv.org/abs/2605.11212)) **[preprint, 2026]**. The model-agnostic half: dedupe
  identical consecutive captures and prefer the tree when pixels did not change.
- Token economics: each screenshot costs roughly **1,000–1,800 input tokens**; pruning must be batched (keep
  last three, prune every ~25 turns) or prompt caching breaks every turn, and on several current models pruning
  a screenshot invalidates later thinking blocks — so *resizing beats pruning* **[shipped]**.

**Why it fits PandaCode.** The pieces exist but are not joined: `capture_browser` captures, Jev checks declared
`expectedText`/`expectedTitle`/`expectedUrl`, and `pandacode_progress_snapshot` renders annotated images with
`box`/`circle`/`arrow`/`pin` and a before/after slider. Nothing asks an agent to *compare* after to before and
say what changed, and nothing states an observation budget, so long loops re-send identical PNGs.

**Cost & complexity.** S–M, mostly prompt and contract. Rust: hash captures, mark repeats. TS: progress-pip
already has the compare slider.

**Proposal — an observation contract with local change detection.**
1. `capture_browser { annotate?, compareTo? }`: with `compareTo`, return the new PNG plus a *computed* changed
   region list (merged pixel-delta boxes, capped at 10) and a one-liner (`3 regions changed; largest 412×88`).
   A local diff needs no model and turns "did my click work?" into a checkable fact.
2. State the loop rule in app instructions: every mutating browser action is followed by a capture; if the last
   two captures are identical, say so and do not spend a turn on it. Cap retained captures at three.

**Acceptance signal.** A three-step scripted flow (open, click that changes nothing, click that changes a
region) yields `0 regions changed` then a non-empty list, and a recorded session shows the next action differing
after the no-op detection. Assert the region math in a Node unit test over fixed PNGs, the no-op path in
`tests/browser.spec.ts`.

## 3. Browser-agent patterns to copy, and to skip

**What it is.** Practitioner patterns: pruned a11y/DOM snapshot with element IDs; explicit waiting rather than
sleeps; scoped reads; deterministic replay of a recorded trace.

**Evidence.**

- Element IDs and scoped reads are the documented shape of both browser-use (three CDP sources merged into one
  node tree) **[tooling]** and Claude's `read_page` (`filter: "interactive"`, `depth`, `ref` to scope a subtree,
  a hard 50,000-character cap with an explicit truncation note) **[shipped]**. Deterministic refs are what make a
  plan replayable; the counter-pattern is returning a full fresh tree after every click **[tooling]**.
- Network-idle is conspicuously *absent* from the newest toolsets: both use explicit `wait {duration}` plus an
  observation call, and the browser toolset offers `read_console`/`read_network` as an opt-in diagnostic rather
  than a blocking condition **[shipped]** — deliberate, since idle detection fails on long-polling pages.
- Record/replay has honest limits: a checksum trace *detects* divergence but does not *reproduce* it, and
  "detection isn't reproduction" is the thing to spike first
  ([log replays](https://a327ex.com/logs/log-replays)) **[tooling]**.

**Why it fits PandaCode.** `read_browser` already caps text at 24,000 chars and elements at 100, but the caps
are silent and undifferentiated. Jev runs in a *new isolated Chrome profile*, so runs are reproducible in
principle; nothing persists a machine-replayable trace, only a report.

**Cost & complexity.** S for wait/diagnostics; M for a recorder. Rust for trace persistence, TS for a viewer.

**Proposal — a bounded read plus a recorded action trace.**
1. `read_browser` gains `scope` (ref or selector), `filter: "interactive" | "all"`, `depth`, and reports
   truncation explicitly (`… 118 more elements not shown; narrow with scope`).
2. Do **not** build network-idle waiting. Build `wait_for { ref, state: visible|enabled|text }` with a timeout
   and a specific error.
3. Record every action as an append-only trace: `{step, action, ref|selector, resolvedNodeSignature, url,
   captureHash}`, stored with the task. On a Jev failure offer "replay steps 1–N"; on a signature mismatch report
   the first divergent step instead of replaying blindly.

**Acceptance signal.** Replaying a passing run reproduces every step with matching signatures; replaying against
a mutated fixture reports the exact first-divergent step and clicks nothing after it. Assert with two recorded
traces in a Rust test.

## 4. Vision for documents and diagrams: OCR vs VLM vs layout models

**What it is.** Three families: classical OCR / text-layer extraction; a VLM prompted to transcribe; a
layout-aware model doing layout detection, recognition *and* reading order together.

**Evidence.**

- dots.ocr unifies layout detection, text recognition and reading order in one 1.7B VLM, reporting SOTA
  multilingual parsing ([arXiv:2512.02498](https://arxiv.org/abs/2512.02498)) **[preprint, 2025]**. olmOCR is a
  fully open 7B VLM trained on 260K PDF pages then RL'd against *visual unit tests* (binary structural-fidelity
  checks), shipping a bench others reuse ([ACL 2026 demo](https://aclanthology.org/2026.acl-demo.62.pdf))
  **[paper, 2026]**; third-party bench runs across 11 models are published **[tooling]**.
- The practical split is stable: never rasterise a PDF that has a text layer; scanned pages and slide decks need
  a layout model; *diagrams* (boxes and arrows) are a structure problem no OCR solves.

**Why it fits PandaCode.** `read_document_file` + `src/office-viewer.ts` already render PDF/DOCX/XLSX and draw
PDF canvases only (no annotation layer), treating documents as untrusted. Extraction is proven, but there is no
**structure** (tables as rows, reading order) and no **diagram** channel: a wireframe in a moodboard or a chart
screenshot is something to look at, not a graph to reason over.

**Cost & complexity.** S to expose structure; L to add a local layout model (~1 GB download). A cloud VLM is
network + per-page cost and conflicts with the local-first posture unless opt-in.

**Proposal — structure-first document reads, with an explicit diagram path.**
1. Return a *layout outline* beside the text: headings, tables as real rows/columns, reading order, figure
   captions — from the text layer where present.
2. For diagrams, return the image plus a bounded, human-checkable description request marked as model-derived,
   rather than silently "understanding" it.
3. Any layout model is an explicit opt-in add-on, mirroring Jev's model.

**Acceptance signal.** A 20-page fixture set (text PDF, scanned page, XLSX with merged cells, two-column slide)
yields correct table row/column counts for machine-readable cases and an explicit "layout model needed" result
for the scanned one — no silent flattening. Assert table shapes in a Node unit test.

## 5. Visual diffs as a review signal

**What it is.** Compare a rendered surface before and after a change and present the delta — image diff, region
list, or both — so a human or agent can judge intent versus accident.

**Evidence.** Visual comparison is mature and *shipped* in test tooling: Playwright's
`expect(page).toHaveScreenshot()` creates a baseline then compares, with documented threshold and
baseline-management workflows ([docs](https://playwright.dev/docs/test-snapshots)) **[tooling]**. The
agent-specific evidence is about *placement*: the judge result (fact 4) is feedback, not a gate — its gain comes
from feeding the verdict back so the agent retries **[paper]**. Honest caveat: pixel diffs are noisy on
antialiasing, fonts and animation, so they are a *signal to look*, not a pass/fail oracle unless masked.

**Why it fits PandaCode.** The design canvas has every ingredient but the diff: artboards are
`<iframe sandbox="allow-same-origin" srcdoc>` that cannot run scripts, comments carry `selector` + `bbox`, and
`refresh()` already re-reads only artboards whose size or mtime changed. Progress snapshots likewise carry
numbered marks and a compare slider.

**Cost & complexity.** S–M. TS for presentation; the pixel comparison itself is a small image diff. Local.

**Proposal — "what changed" on surfaces agents already render.**
1. Design canvas: when an artboard's mtime changes, diff against the previous version and show a third state
   beside the artboard (region overlay via the progress-mark primitives, plus "3 regions changed"), then pass the
   region list into the design-changed prompt so a revision is judged against what actually moved.
2. Progress snapshots: compute the same region list for iteration *n+1* and show it in the filmstrip caption.
3. Never auto-fail on a diff — the wording stays "changed", not "regressed".

**Acceptance signal.** Rewriting one artboard changes only its own diff; the region count matches a hand-counted
fixture; an unrelated mtime touch produces zero regions. Assert region math on fixed PNGs and the overlay in
`tests/design-canvas.spec.ts`.

## 6. Generative / structured UI as an agent output channel

**What it is.** The agent emits a UI description the host renders with *its own* components, rather than raw
HTML. Structured (schema/component) output is the safe variant; free-form HTML is the risky one.

**Evidence.**

- The risk is measured: a CHI 2026 study of **1,296** LLM-generated e-commerce components found **55.8%**
  contained at least one deceptive design pattern and **30.6%** two or more; emphasising business interests
  raised the rate **+15.8 pp** ([Deception at Scale](https://dlnext.acm.org/doi/10.1145/3772318.3791063))
  **[paper, CHI 2026]**; generated layouts also violate contrast/WCAG requirements **[paper]**. Agents are
  steered in the other direction too — GUI agents can be manipulated by dark patterns in the pages they read
  ([Dark Patterns Meet GUI Agents](https://dl.acm.org/doi/10.1145/3772318.3791568)) **[paper]**.
- The industry response is standards, not just sandboxes: A2UI v0.9 for portable framework-agnostic generative
  UI and AG-UI for the interaction stream, with "a component system, not arbitrary AI-generated code" as the
  principle ([Google](https://developers.googleblog.com/a2ui-v0-9-generative-ui/)) **[shipped, 2026]**.

**Why it fits PandaCode.** It is already on the safe side: `generative-ui.ts` renders fenced
`ui`/`chart`/`svg`/`html` in a shadow root, runs no agent code, and buttons only *fill the composer*; HTML is
sanitised and `rich-markdown` rejects forms, frames and non-inline images. That is a component system in all but
name — it just has no *schema* and no *accessible contract* the agent can target.

**Cost & complexity.** M. TS in `generative-ui-components` plus a schema module; accessibility is the expensive
half.

**Proposal — a small declared component schema with contrast and label guarantees.**
1. Publish a bounded schema (`card`, `row`, `segmented`, `chart`, `callout`, `table`, `form`) with typed props and
   *required* text alternatives (`label`, `alt`, `summary`). Reject unknown components; keep the `html`/`svg`
   fence as an explicitly-labelled inert "source example".
2. Render only from `--ds-*` tokens, so the existing palette guards (`tests/palette.test.mjs` — contrast over
   every scene and 23 recorded themes) cover agent output for free.
3. Require a one-line `summary` on every chart and table as its accessible name; refuse a chart without one.

**Acceptance signal.** An unknown component renders an explicit "unsupported component" card rather than
degrading; every chart has an accessible name; a sweep of all components under light, dark, high-contrast and one
imported VS Code theme passes existing contrast thresholds. Assert in `tests/generative-ui.spec.ts` plus a
`tests/design-tokens` extension.

## 7. Realtime speech: streaming, interruption, latency budget

**What it is.** Turn a dictation box into a conversation channel: stream recognition, detect end of speech, allow
barge-in, keep latency under perceptual thresholds.

**Evidence.** The production target is consistently **under ~500 ms** end-to-end, with first-audio-byte as the
metric that matters and endpointing/VAD as a named budget component
([General Compute](https://www.generalcompute.com/blog/voice-agents-and-the-500ms-window),
[onepin](https://onepin.ai/blog/voice-agent-latency-budget-breakdown-2026)) **[tooling, 2026]**; 500–900 ms P95 is
the quoted comfortable band for agent turns **[tooling]**. Interruption is first-class, not an edge case:
barge-in, turn detection and reconnection are required behaviours of realtime APIs
([AssemblyAI](https://www.assemblyai.com/blog/voice-agent-api-vs-universal-3-pro-streaming)) **[tooling]**.
Streaming ASR is already catalogued first-party: models carry a **Live preview** badge and a speed figure for
30 s of audio (`docs/voice-input.md`) **[tooling, first-party]**.

**Why it fits PandaCode.** Dictation is deliberately not a conversation — two-minute cap, no auto-send,
transcript-review card, insertion-location tracking that survives thread switches. That is right for composing a
prompt and should stay. The honest gap is narrower: no **live partial transcript** while speaking, no
**barge-in** concept, and no measured latency budget.

**Cost & complexity.** M for streaming preview, L for realtime conversation. Rust (capture, VAD, streaming
decode) + TS (tray, interruption semantics). Local models keep it offline.

**Proposal — a live preview and an explicit budget, not speech-to-speech.**
1. When the selected model advertises live preview, render the partial transcript in the existing recording tray,
   keeping the read-only draft, review-on-finish and insert/retire rules unchanged.
2. Instrument three numbers per recording: time-to-first-partial, time-to-final, stop→text-inserted. Show them
   behind an advanced disclosure, not in the main tray.
3. Do not auto-send and do not add barge-in until (1) is measured — barge-in without a measured endpointing story
   is how voice UIs start cutting people off.

**Acceptance signal.** With a live-capable local model, the first partial appears before speech ends in ≥90% of a
20-utterance fixture set, and stop→insert stays under a stated budget; the transcript still lands in review when
the draft changed. Assert partial-merge and insert-location in `tests/voice-input*.test.mjs` with recorded audio;
keep the browser suite on synthetic events (it cannot prove hardware capture — already documented).

## 8. Human-in-the-loop: approvals, intent previews, undo

**What it is.** Where the human sits: a gate *before* (approval), a *preview* of intent, or a *reversal* after
(undo). Different cost, different failure mode.

**Evidence.**

- The gate is normative in shipped guidance: ask a human to confirm decisions with real consequences (accepting
  cookies, financial transactions, agreeing to terms), and make that check **before each action**, "because one
  turn can carry several"
  ([computer use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)) **[shipped]**.
  `docs/approvals.md` already implements this tiering per harness.
- Intent preview is converging as a named pattern — show the plan before significant work so it can be approved,
  edited or rejected, reserved for what cannot be undone
  ([agentic-ux](https://agentic-ux.com/patterns/intent-preview), [Eleken](https://www.eleken.co/blog-posts/agentic-ux-examples))
  **[tooling, 2026]**: pattern settled, magnitude unmeasured.
- The honest limit on undo is PandaCode's own: "**Files are not rewound**" (`docs/rewind.md`). Prompt-level
  edit/fork is safe because it changes no files; file-level undo is a much larger promise.

**Why it fits PandaCode.** Tiers exist and are enforced natively, and `ask_user` plus approval cards provide the
gate UI. What is missing is a **risk tier on interface actions**: `browser_click` says "obtain user authorization
first" in prose only, with no mechanical rule such as "a click whose accessible name matches
/pay|delete|confirm|subscribe|accept/ is gated even in Full access".

**Cost & complexity.** S–M. TS for the preview card; Rust for a small classifier and the gate hook in the
browser/Jev action path. Local; pattern-based is enough, one model call if semantic.

**Proposal — risk-tiered intent preview on interface actions.**
1. Classify each action: *read* (read/scroll/navigate to an allowlisted host) never gated; *reversible*
   (click/type without submit) gated outside Full access; *consequential* (submit, purchase, delete, permission
   grant, or a name matching a small lexicon) gated in **every** mode, because the vendor guidance gates
   consent-requiring actions unconditionally.
2. Show a one-screen preview for consequential actions — target ref + accessible name + page + exact action, with
   Approve / Edit / Reject — reusing the `ask_user` card renderer.
3. State plainly that undo covers files and prompts, not third-party state.

**Acceptance signal.** On a fixture site, a Full-access click on "Delete account" is stopped and shows the
preview; "Next page" proceeds ungated; the lexicon is table-driven so a new verb is a one-line change. Assert in
`tests/browser.spec.ts` plus a Rust unit test over the classifier.

## 9. Accessibility and keyboard-first flows

**What it is.** The structure that makes a UI usable by a screen reader also makes it addressable by an agent;
keyboard paths and accessible names are both an inclusion requirement and an agent affordance.

**Evidence.** The two literatures converge: an a11y tree *is* the machine-readable description, so a control with
no accessible name is one an agent cannot reliably target. Claude's guidance recommends keyboard shortcuts where
pointer manipulation is unreliable **[shipped]**. The generative-UI literature reports generated layouts failing
contrast and structure requirements **[paper]** — agent-produced UI is a *source* of accessibility debt.

**Why it fits PandaCode.** Unusually well placed: `AGENTS.md` forbids literal accent colours, mandates `--ds-*`
tokens, one radius per element kind, and a contrast-guarded palette; `progress-pip` is keyboard operable with
arrow/Home/End and defined Esc precedence; `agents-dock` returns focus correctly on Escape. The discipline exists
but has never become a *contract for agent output* or a *precondition for agent input*.

**Cost & complexity.** S. Mostly lint and prompts; no new subsystem.

**Proposal — accessibility as the agent contract, both directions.**
1. Inbound: `read_browser` refs carry `role` + accessible `name`; a node with neither is emitted as `unnamed` and
   deprioritised, steering the agent to targets a screen reader could also reach.
2. Outbound: schema components (§6) require text alternatives, so the existing contrast guards apply.
3. Keyboard: document and test that every agent-rendered interactive surface (canvas comment mode, progress
   filmstrip, agents dock, approval cards) is keyboard operable, and prefer keyboard paths when a pointer target
   is ambiguous.

**Acceptance signal.** A fixture page with an unlabelled icon button produces an `unnamed` ref the agent skips in
favour of the labelled neighbour; the a11y lint over `src/*.css` and shadow builders stays green.

## 10. Multi-window, background agents and attention

**What it is.** Several agents run at once; the app must let a person monitor, switch and be interrupted without
being flooded.

**Evidence.** The thinnest area here — design practice, not measurement. The one hard adjacent fact is that
unattended success is still low: OSWorld's multi-application workflows capped at **6.57%** **[paper]**, and the
judge work exists because agents misjudge their own completion **[paper]**. Background autonomy needs a human
checkpoint rather than silent running.

**Why it fits PandaCode.** It has built more than most: `agents-dock` shows per-agent status (`running`,
`waiting-for-approval`, `waiting-for-input`, `waiting`), elapsed time on one shared clock that stops when empty,
and pin-to-own-window; `thread-tiles` tiles up to six threads around one focused real thread. The status
vocabulary is the right primitive; it does not **prioritise**.

**Cost & complexity.** S. TS only.

**Proposal — rank by "needs a human", not recency.** Order rows by blocking severity (`waiting-for-approval` and
`waiting-for-input` above `running`, then `waiting`), make the count badge distinguish *blocked* from *busy* in
two tones, and keep elapsed time as the only per-row clock — another timer per agent is the noise that trains
people to ignore the dock.

**Acceptance signal.** With three agents (approving, running, idle) the dock orders approval → running → idle and
the badge reports one blocked; a status flip does not reorder a focused row under the pointer.

## 11. Inline edit/diff UX and intent previews for code

**What it is.** How a proposed change is presented: a diff accepted or rejected per hunk, an inline edit, or a
plan summary before the edit.

**Evidence.** Edit *format* is measured and settled in note 03 (search/replace beats line-numbered diffs, **59%
vs 26%** on aider's harness). *Presentation* is the intent-preview pattern from §8: visible intent, preview,
authorization, feedback, recovery, audit ([agentic UI patterns](https://pixso.net/articles/agentic-ui-patterns/))
**[tooling]** — consensus without measurement.

**Why it fits PandaCode.** `@pierre/diffs/edit` already gives hunk-level review with a read-safety check,
`turn_changes` + `pandacode_track_files` give an authoritative changed-file list, and `src/change-review.ts`
exists. The gap is *ordering*: the reviewer sees the diff after the turn, with no "here is what I am about to
change" moment for a large edit.

**Cost & complexity.** S (ordering/prompt) to M (pre-turn preview). TS.

**Proposal — reuse the diff surface as the intent surface.** For turns touching more than a threshold of files
(say >5) or any file over a size threshold, have the agent emit its plan as structured markdown rendered in the
same card that later shows the diff; approve/edit/reject before the edit lands.

**Acceptance signal.** A six-file turn shows the preview and waits; a two-file turn does not. Assert the threshold
branch in `tests/turn-card.spec.ts`.

## 12. Simulation and remote surfaces (VMs, simulators)

**What it is.** The same perceive/act contract applied to a virtual screen rather than a DOM.

**Evidence.** PandaCode's VM path gets ground truth right: `vm/rfb.rs` waits a quiet window because the RFB
server "answers only when the screen changed", and frames scale to 1280 px wide — the discipline vendor docs
prescribe (resize to a known baseline, scale coordinates back by the inverse factor, never let the model's frame
drift from the executor's) **[shipped]**. AndroidWorld has saturated (**100%** pass@1 claimed by five agents) and
its sheet was archived ([AndroidWorld](https://benchmarkingagents.com/androidworld/)) **[benchmark, Nov 2026]** —
simulator leaderboards no longer discriminate, so judge tools by task success on real apps.

**Why it fits PandaCode.** `simulator_control` already does `tap`/`swipe`/`type`/`key` in points with screenshots,
and `simulator_describe` returns accessibility elements (label, value, id, center) — the mobile path *already has
refs*. The asymmetry is that the DOM path lacks what mobile has.

**Cost & complexity.** S. Rust contract + TS presentation; local.

**Proposal — one observation schema across browser, VM and simulator.** Define it once
(`{ref, role, name, state, bounds, source}`) and have `read_browser`, `simulator_describe` and the VM path all
speak it, so a harness sees one shape whether clicking a DOM button, a phone icon or a VM window. Add the missing
VM piece: label capture regions so an agent can refer to "the dialog's OK button" rather than pixels.

**Acceptance signal.** One recorded task (open a form, fill a field, submit) runs through the same schema on
browser and simulator with only the executor differing; the VM path returns labelled regions for a fixture frame.

## 13. Ranked shortlist

| # | Upgrade | Confidence | Why it ranks here | Effort |
|---|---|---|---|---|
| 1 | **Refs in `read_browser`, stale-ref error, annotated `capture_browser`** (§1) | High | Attacks the largest measured failure mode (75% grounding) with the shape both current vendors converged on; small, local, testable, no new dependency | M |
| 2 | **Observation contract: mandatory post-action capture + local changed-region diff + capture dedupe** (§2, §5) | High | Judge result (+27% relative) and shipped prompting guidance both say verification-with-feedback is the lever; every ingredient already exists | S–M |
| 3 | **Visual diff on design canvas and progress snapshots** (§5) | Medium-high | Turns two existing tested surfaces into review evidence; deterministic region math; no model in the loop | S–M |
| 4 | **Risk-tiered intent preview on interface actions** (§8) | Medium | Ships the vendor guidance that consent-requiring actions are gated before *each* action; closes a real hole in Full access; magnitude unmeasured | S–M |
| 5 | **Declared component schema for generative UI with required text alternatives** (§6) | Medium | 55.8% deceptive-design rate is the strongest adversarial number here; token/contrast guards make the fix unusually cheap in this codebase | M |

Deferred but real: the unified observation schema across browser/VM/simulator (§12 — high value, needs two
executors to agree first) and streaming dictation preview (§7 — depends on which local models ship live preview).

## 14. Rejected or already covered

- **Speech-to-speech conversation** — rejected near-term. The measured target (<500 ms, barge-in, endpointing) is
  a different product from a composer; dictation deliberately never auto-sends and tracks insertion across
  threads. Do streaming preview and measure.
- **Network-idle waiting in the browser tool** — rejected. Newest shipped toolsets avoid it; unreliable on
  long-polling pages. Use `wait_for {ref,state}` plus observation.
- **Set-of-Mark as the default observation format** — downgraded, not rejected: OSWorld found SoM and a11y trees
  can *mislead* models, so make annotation opt-in and prefer refs when a tree exists.
- **Screenshot pruning as the first token saving** — mostly rejected: pruning invalidates later thinking blocks;
  resize and dedupe instead, prune in batches only if needed.
- **Free-form agent HTML as a rendering target** — rejected as a default. Already half-rejected in code; the
  remaining step is a schema so the safe path is the easy path.
- **Whole-file rewrite / line-numbered diffs as edit presentation** — settled in note 03 (59% vs 26%).
- **Undo as a general safety net for interface actions** — rejected. `docs/rewind.md` says files are not rewound;
  extending "undo" to a click on a live third-party site is a false promise. Gate instead.
- **Simulator/desktop benchmarks as quality signals** — rejected. AndroidWorld is saturated and archived, and
  OSWorld-Verified entries exceed its human baseline. Judge on task success against fixtures.
- **Attention heuristics beyond dock ordering** — not pursued; no measurement exists, so status vocabulary plus
  severity ordering is the defensible slice.
- **Already covered, do not re-propose** — browser automation with screenshots, simulator control, voice
  dictation, generative UI blocks, the design canvas, progress snapshots and document viewers all exist.

## Sources

OSWorld — https://arxiv.org/abs/2404.07972 · failure analysis — https://beancount.io/bean-labs/research-logs/2026/06/15/osworld-benchmarking-multimodal-agents-real-computer-environments · OSWorld-Verified board — https://benchmarkingagents.com/osworld/ · WebArena — https://arxiv.org/abs/2307.13854 · WebArena board — https://leaderboard.steel.dev/leaderboards/webarena/ · AndroidWorld — https://benchmarkingagents.com/androidworld/ · Set-of-Mark — https://arxiv.org/abs/2310.11441 · SeeAct — https://arxiv.org/abs/2401.01614 · ScreenSpot-Pro — https://arxiv.org/abs/2504.07981 · UI-TARS — https://arxiv.org/abs/2501.12326 · Anthropic computer use — https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool · Anthropic browser use — https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool · Anthropic harnesses — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents · "Are We Done Yet?" — https://arxiv.org/abs/2511.20067 · ReVision — https://arxiv.org/abs/2605.11212 · Playwright snapshots — https://playwright.dev/docs/test-snapshots · Playwright agent CLI — https://playwright.dev/agent-cli/introduction · browser-use DOM tree — https://deepwiki.com/browser-use/browser-use/4.1-dom-tree-construction · dots.ocr — https://arxiv.org/abs/2512.02498 · olmOCR — https://aclanthology.org/2026.acl-demo.62.pdf · Deception at Scale — https://dlnext.acm.org/doi/10.1145/3772318.3791063 · Dark Patterns Meet GUI Agents — https://dl.acm.org/doi/10.1145/3772318.3791568 · A2UI v0.9 — https://developers.googleblog.com/a2ui-v0-9-generative-ui/ · AG-UI stack — https://www.marktechpost.com/2026/01/29/beyond-the-chatbox-generative-ui-ag-ui-and-the-stack-behind-agent-driven-interfaces/ · 500 ms window — https://www.generalcompute.com/blog/voice-agents-and-the-500ms-window · latency budget — https://onepin.ai/blog/voice-agent-latency-budget-breakdown-2026 · voice API guide — https://www.assemblyai.com/blog/voice-agent-api-vs-universal-3-pro-streaming · intent preview — https://agentic-ux.com/patterns/intent-preview · agentic UX patterns — https://www.eleken.co/blog-posts/agentic-ux-examples · agentic UI patterns — https://pixso.net/articles/agentic-ui-patterns/ · log replays — https://a327ex.com/logs/log-replays
