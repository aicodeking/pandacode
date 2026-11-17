# Thirty-plugin parity and the uncovered-contract map (R1212)

Owner: runtime task R1212. Source of the study: the extension runtime plan's gap study (`PLAN-gaps.md`), kept in the project's
work folder, which is not part of this repository. Gap tables G1-G8, A1-A7, F1-F8 and the S06xx handoffs: the upstream content
plan, section S07C, in the same folder. Per-task evidence: the sections of the extension runtime receipt there.

## How to read the evidence

- The whole run followed the binding user decision of 2026-11-16: no tests until the final phase. Every row below is
  **implemented and compile-checked; tests written, not run**. Nothing here says a test passed, and nothing says an
  installed build accepted the behaviour. Preview, native and installed/live are separate columns in each receipt section
  and the installed/live column is **pending** everywhere.
- Source feasibility is never installed acceptance. "Implemented" means the contract, its validators, its fixtures and (where
  named) a reference package exist in the tree; it does not mean the call site is wired into the app (see the wiring table).
- Commit ids come from `git log` (read-only): the subject starts with the task id.
- User decision 2026-11-17: the package-companion line **R0601-R0606 was skipped** after repeated safety-classifier stops. Every
  row that needs a companion (capability C8) ends with that named decision and "pending - separate user design". No
  companion source, harness version or request-rewrite claim is made anywhere.
- Pending person decisions: **A5** (offer package tools to ZCode through the per-session MCP bridge; unwired), the **live Claude
  hook capture** (R0501 gate `claude-hook-callback-capture`, needs separate authorization), and the **macOS/Linux runners**
  (R1102: those targets stay `UnsupportedRuntime`, four runners are external inputs).

## Capability to task map (what each key means in this table)

| Key | Capability | Tasks and commits (compile-checked, tests not run) |
|---|---|---|
| C1 | Background service | R0104 `f4991da`, R0105 `b1c44f9`, R0106 `3a8dc56`, R0107 `2090e86`, R0108 `42bdf27`, R0201 `93a8686` |
| C2 | Host events | R0202 `63070bc`, R0507 `f10f1c4` |
| C3 | Dynamic interface | R0205 `11c9b7b`, R0206 `0cd33de`, R0208 `d66aa47` |
| C4 | Notifications | R0207 `8f93f4c` |
| C5 | Rich panels | R0301 `19625f5`, R0302 `09d5989`, R0303 `47d3531`, R0304 `a3293c3`, R0305 `419b1f8`, R0306 `e9029e8` (qualification prepared) |
| C6 | Tasks and drafts | R0401 `312c8aa`, R0402 `0d4436b`, R0403 `4625631`, R0404 `19fe7dc`, R0404B `1b75873` |
| C7 | Hooks | R0501 `495cd4e`, R0502 `fae2d38`, R0503 `776d0a8`, R0504 `37c9346`, R0505 `c920ad4`, R0506 `b92dfca`, R0507 `f10f1c4`, R0508 `ac906c2`, R0509 `c13246d` |
| C8 | Companions | **R0601-R0606 skipped (user decision 2026-11-17). Pending - separate user design.** |
| C9 | Model tools, tool servers | R0701 `c36818f`, R0702 `c16381e`, R0703 `332e5b3`, R0704 `7c8957b`, R0705 `dec4df8` |
| C10 | Credentials, sign-in, provider parity | R0802 `b3c35e4`, R0803 `ab95436`, R0804 `0956531`, R0805 `d9a5b77`, R0806 `80d8885`, R0807 `f984809`, R0801 `54ab20a` |
| C11 | Documents | R0901 `aede80f`, R0902 `b59c7a4`, R0903 `64d9f20` |
| C12 | Presentation | R1001 `d603f3d`, R1002 `28b8d5b`, R1003 `1880b29`, R1004 `69fe619` |
| C13 | Platforms | R1101 `3f16e03` (prepared, nothing enabled), R0306, R1102 `dccdd6f` (pending human input) |

Reference packages (the nine of PLAN-examples): `sample.live-board` R1201 `079fc26`, R1202 `ed66c33`, R1203 `404181d`;
`sample.monitor` R1206 `45dd374`; `sample.inbox` R1210 `e115c83`; `sample.guard` R1204 `b40055f`; `sample.memory` R1207
`ab0338f`; `sample.signin` R1209 `4292583`; `sample.usage` R1208 `32c525b`; `sample.sql-notebook` R1211 `1aebc1c`;
`sample.arcade` R1205 `f3e29b2`. The tenth is not invented: no example proves a companion; the R6 fixture would have been its
explicit evidence and is part of the skipped line.

## The thirty parity rows

Verdict "Before" is the study's. "After" says which reference package or phase fixture shows the behaviour, in which column,
with the task id; each row ends with the remaining limit or the named decision. Every row: tests written, not run; installed
column pending.

### Orca app plugins

| # | Plugin | Before | After (evidence, limit, decision) |
|---|---|---|---|
| 1 | Beads Board | No | **Implemented** as `sample.live-board` (C1, C3, C5, C6): cut A service + dynamic UI R1201, cut B rich panel with 2,000-issue chunked board, undo and conflict handling R1202, cut C attributed start of a fake-agent task with a previewed prompt R1203; contracts R0104-R0208, R0301-R0306, R0401. Preview and native columns written, not run; installed Windows runner prepared, not run. Limits: project and harness are typed text in cut C; Orca's own board status ids stay out of scope (redesigned around B2 data). Final-phase edit owed in R0306's `stage.mjs`/`expected.json`. |
| 2 | Fleet Monitor | No | **Implemented** as `sample.monitor` R1206 (C1, C3, C4, C5): pacing by panel visibility, levels, replaceable notices with caps, daemon-offline stale state, chart panel; contracts R0104, R0202, R0205, R0207, R0301. Written, not run. Limits: no per-core/process data (no contract exposes it); `panda.ui.notify` has no operating-system-notice flag or action (see new contract U1 below); paired-server metrics only Orca has stay out. |
| 3 | Sidequest (games) | No | **Implemented** as `sample.arcade` R1205 (C5, panel-only, no service): focus-aware canvas game, journal storage, theme, containment hooks; contracts R0302, R0304, R0305. Written, not run. Limit: one game, not the model's 21; the streaming-task behaviour (plan behaviour 8) is installed-only and not observed. |
| 4 | Agent Inbox | No | **Implemented, call-site wiring partly pending** as `sample.inbox` R1210 (C1, C5, C6, C7): pending approvals/questions as durable events R0507, answering through `panda.tasks.respond` with one winner R0508, three model tools R0701, once-per-task brief R0504, reply R0402. Written, not run. Limits: a notice has no click action (U1); task titles are ids; team-worker requests never show as pending; secret questions are answered in the window (ADR-0006). Real-harness capture is a pending person decision. |
| 5 | n8n in Orca | Partial | **Implemented at contract level; no dedicated package built.** The pieces (C5 panel R0301-R0306, C10 held credentials without reading R0805, declared JSON connections R0804) each have fixtures and are combined partly in `sample.signin` R1209 and `sample.live-board` R1202. The exact combination (a panel over a held-credential connection) has no package. Decision: not a tenth package ("no tenth example"); to be proven only in the final phase by a fixture if the user asks. Installed: pending. |
| 6 | Feeds | No | **Implemented at contract level; no dedicated package.** C1 timers R0104/R0201, C5 R0301-R0306 and C6 R0401/R0403 are exercised by `sample.live-board` R1201-R1203 and `sample.monitor` R1206 (service polling pushing to a panel; cut C starts a task from rows). Feed fetching with TTL has no package. Limit: package network access is its own code (Node service), outside platform contracts. Installed: pending. |
| 7 | DB Studio | No | **Implemented** as `sample.sql-notebook` R1211 (C1, C5, C11): custom editor over the audited host buffer R0901, save hook R0902, template new file R0903, query in a short-lived child process (a thread cannot stop a runaway statement). Written, not run. Limits: behaviour 9 (click a table to create a note) not built: SDK has no service call to create a project file (new contract U2); no project folder call (U3); editor shell, rich channel and new-file menu are not yet wired to `DocumentEditors`/`SaveFlow`/`NewFiles` (call-site wiring pending), so the installed behaviour is "prepared". |
| 8 | Claude Accounts | Native | **Implemented as an extension** (C3, C4, C10): account rows, switch and limits come from `sample.signin` R1209 (sign-in, own secrets, refresh, rotation, `providers.update`) and the account/limit read in `sample.usage` R1208, over R0204 and R0805/R0806. Written, not run. The built-in Claude account behaviour is untouched. Limit: rotation moves the service's reads, not a running task. |
| 9 | GraphiQL | No | **Implemented at contract level; no dedicated package.** Editor, save hook and template are `sample.sql-notebook` R1211 (R0901-R0903); credentialed requests are R0804/R0805. Schema introspection panel has no package. Same wiring limits as row 7. Installed: pending. |
| 10 | Office Tycoon | No | **Implemented at contract level; no dedicated package.** Panel play is `sample.arcade` R1205 (C5); a long-running service with timers and events is `sample.monitor` R1206 / R0202. No simulation package. Installed: pending. |

Not closable by the platform and stated, not hidden: Orca-only data (paired-server metrics, cross-host agent list, board
status ids).

### Claude Code mods, literal first ten

| # | Mod | Before | After (evidence, limit, decision) |
|---|---|---|---|
| 1 | ruview-live | No | **Implemented at contract level** (C1, C3, C5): service + live items + panel via R1201/R1206 packages. No package of its own. Terminal panes a mod draws inside a harness never show (stays out); PandaCode panel is the equivalent. |
| 2 | ruflo-adr | No | **Implemented, hooks unqualified for Claude** (C7): `tool.before`/`prompt.submit`/observe hooks R0501-R0509 and the `sample.guard`/`sample.memory`/`sample.inbox` packages show decide, context and observe on fake ACP frames (synthetic and SDK-derived, labelled). Pending person decisions: **live Claude hook capture** (R0501 gate), hence Claude, GLM and MiMo hook qualification. No package of its own. |
| 3 | ruflo-agent | No | Same as row 2 (C7). Pending: live Claude hook capture. |
| 4 | ruflo-agentdb | No | Same as row 2 (C7); persistence side is `sample.memory` R1207 (package data directory R0105). Pending: live Claude hook capture. |
| 5 | ruflo-agntcy | Yes | **Implemented** (C2): start-of-session and task events R0202/R0507 with scoped delivery; fixture `sample.pending-inbox` and `sample.inbox`. Native-equivalent was already "Yes". Written, not run. |
| 6 | ruflo-ai-team | No | Same as row 2 (C7). Team worker requests never show as pending (R0507 limit); worker controls are R0404B. Pending: live Claude hook capture. |
| 7 | ruflo-aidefence | No | **Implemented** as the pattern of `sample.guard` R1204 (deny with reason, rewrite `--force-with-lease`, tool-row signals via R1004). Written, not run. Limits: the decision line and tool-row note wiring are call-site pending (R1004 `main.ts` callbacks, R0705 annotate call sites); Claude hook qualification pending the live capture. |
| 8 | ruflo-arena | Yes | **Implemented** (C2): events R0202. Written, not run. |
| 9 | ruflo-autopilot | No | **Implemented, hooks unqualified for Claude** (C7): approve/deny/ask and scoped full mode R0505, late answers R0508, chains and user order R0506; `tasks.control` R0404. Pending: live Claude hook capture. |
| 10 | ruflo-bbs-federation | No | Same as row 2 (C7); network federation is the package's own code. Pending: live Claude hook capture. |

### Claude Code mods, one per repository (ranks 3 to 10, supplementary eight rows)

| # | Repository (mod) | Before | After (evidence, limit, decision) |
|---|---|---|---|
| 3 | claude-plugins-official | No | **Implemented at contract level** (C3, C5, C6, C7, C12): panels R0301, tasks R0401, hooks R05, presentation R1001-R1004, packages R1201/R1210/R1208. No package of its own. Installed: pending. |
| 4 | oh-my-claudecode (compaction module) | No | **SKIPPED - user decision 2026-11-17 (R0601-R0606). Pending - separate user design.** Host-side compaction context application exists (R0504 `37c9346`); request rewriting inside the harness does not. |
| 5 | firstmate "Calm" | Partial | **Implemented** (C12): transcript/working presentations R1002, composer band R1001, protected-dialog extras and attributed notes R1003. Written, not run. |
| 6 | fast-jev-compaction | No | **SKIPPED - user decision 2026-11-17. Pending - separate user design.** |
| 7 | terminal-browser | Partial | **Implemented** at contract level (C9, panel API for the native browser): model tools R0701, tool servers R0702, browser guest control `guests.control` R0410. Written, not run. Limit: ZCode gets no package tools (A5 pending person decision). |
| 8 | pebrel-prompt-suggestions | No | **Implemented** (C2, C6): events R0202, drafts and attachments without sending R0403, `sample.usage` insert checkpoint draft R1208. Written, not run. |
| 9 | token-optimizer | Partial | **Implemented** as `sample.usage` R1208 (C2, C3, C6, C12): task-scoped band, thresholds, notices, report panel; companion-style cleanup only where `panda.harnesses.list` says the harness compacts. Written, not run. Limit: no usage-report event, so a running task is read every 500 ms. |
| 10 | lcu-approve | No | **Implemented, wiring pending** (C7, C9, native elicitation forms): pending approvals/questions R0507, answers R0508, `sample.inbox` R1210. Form answers are not carried in `question.resolved`. Pending: live Claude hook capture. |

### OpenCode plugins

| # | Plugin | Before | After (evidence, limit, decision) |
|---|---|---|---|
| 1 | oh-my-opencode | No | **Partly implemented; companion part skipped** (C7, C9, C6 done; C8 skipped). Hooks R05, model tools R0701-R0703, tasks R04 exist. C8: **SKIPPED - user decision 2026-11-17 (R0601-R0606). Pending - separate user design.** ZCode tools: A5 pending person decision. |
| 2 | opencode-antigravity-auth | Partial | **Implemented** as `sample.signin` R1209 (flow only): cancellable browser sign-in R0803, own secrets R0802, host-attached held credentials R0805, `providers.update` R0806. Written, not run. The value of a held credential never reaches the package or a stdio launch (ADR-0006); a launched stdio CLI getting a host-attached credential is follow-up F5, not built. |
| 3 | oh-my-opencode-slim | No | Same as row 1: companion part skipped (user decision 2026-11-17), pending separate design. |
| 4 | opencode-dynamic-context-pruning | No | **SKIPPED - user decision 2026-11-17 (C8). Pending - separate user design.** Only the host side exists: R0504 applies prompt context and result changes and compaction. |
| 5 | opencode-openai-codex-auth | Partial | **Implemented** at contract level through the same sign-in parity as row 2 (R0803, R0805, R0806); no Codex-specific package. Written, not run. |
| 6 | cc-safety-net | No | **Implemented** as `sample.guard` R1204 (C7): deny with rule id, rewrite of a plain force push, never approves, audit with redaction. Written, not run. Limits: R1003/R1004 display wiring; fail-closed policy is left to the user; Claude hook qualification pending the live capture. |
| 7 | opencode-mem | No | **Implemented** as `sample.memory` R1207 (C1, C2, C7, C9): model tool `memory`, recall at send through `prompt.submit` context, capture through `models.call`. Written, not run. Limits: the hidden-run path for `models.call` is not attached (every call answers `UnsupportedCapability` in the app, R0704), so capture stores the shortened raw turn with a visible note; companion column pending (R06 skipped); ZCode gets no package tool (A5). |
| 8 | opencode-gemini-auth | Partial | Same as row 5 (sign-in parity R0803/R0805/R0806, `sample.signin` R1209). |
| 9 | opencode-supermemory | No | **Implemented** as `sample.memory` R1207 with private secrets R0802 (C2, C7, C9, C10). Written, not run. Same `models.call` and A5 limits as row 7. |
| 10 | opencode-quota | Partial | **Implemented** as `sample.usage` R1208 (C2, C3, C4): native `usage`/`limits`/`accounts` resources R0204, notices R0207, band R1001. Written, not run. |

Totals: 30 rows (10 Orca, 10 mods literal, 10 OpenCode) plus 8 supplementary repository rows. No row is left without evidence or
a named decision. Rows ending in the named companion decision: mods-by-repository 4 and 6; OpenCode 1 (partly), 3 (partly), 4.
Rows ending "contract level, no dedicated package": Orca 5, 6, 9, 10; mods literal 1-4 and 6-10 (pattern packages only).

## Where the call sites are not wired (rows must not read as closed)

These are recorded in the receipt and make the affected rows "implemented, call-site wiring pending":

| Seam | Receipt | Effect on rows |
|---|---|---|
| Hidden harness run for `panda.models.call` (`set_run` never called) | R0704 | Memory (7, 9), usage; every call answers `UnsupportedCapability` in the app |
| `runtime_cli_intent::annotate` not called by the `tool.before` builder and the transcript row builder | R0705 | Guard/aidefence rows show no package intent |
| Editor shell and rich channel do not call `DocumentEditors::handle`; `SaveFlow::save`/`package_gone` and `NewFiles::handle` not called by the menu/`ui.reveal` | R0901, R0902, R0903 | DB Studio (7), GraphiQL (9) installed behaviour |
| Per-run providers do not read `mcp_entries` | R0702, R0703 | Tool servers and package tools in built-in harnesses: attachment pending |
| `main.ts` does not supply `details`/`decision` callbacks to the tool-row mount | R1004 | Hook-derived chips, `{input}`/`{output}` empty |
| Notices have no click action; no OS-notice flag | R1210, R1206 | Inbox, monitor |
| Panel `storage.*` is not routed through the rich channel (a panel answers `UnsupportedCapability`; the service holds the storage) | R0303 | Panels that expected their own storage keep it in the service |
| The webview usage view does not draw the limit windows a package publishes | R0806 | `sample.usage` windows reach the host state, not the usage band |
| The older brokers (`context.rs`, `jobs.rs`, `connections.rs`, `services.rs`) do not call the native grant `gate` of the runtime | R0102 | Short activations keep their own earlier checks; the service paths rely on the gate |
| The ZCode bridge is not wired (A5) | R0701-R0703 | Package tools are not offered to ZCode; a person decides |

`panda.secrets.*` (R0802) and `panda.auth.signIn` (R0803) were declared and implemented natively but not reachable from a running service until R1302 wired them through the service request path (`secrets` and `authSignIn` in `runtime_service_lifetime.rs`, the `secrets` and `auth` objects of `node-host.cjs`); the grant is rechecked natively on every call, a secret value is only in the reply to its own package, and a service that ends cancels its waiting sign-in. The rows that depend on them (Orca 8, OpenCode 2, 5, 8, 9, `sample.signin`, `sample.memory`) remain "written, not run".

## Example deviations (stated, not parity gaps)

- R1205: one game, not 21. R1207: JSON store, not SQLite. R1211: child process instead of a worker thread; behaviour 9 not built.
  R1206: the operating-system notice is not in the contract. R1202: the claim undo has a small window between `show` and `update`.
  The `memory`, `monitor` and `sql-notebook` entries of `tests/fixtures/extensions/examples-v1.json` and the `usage` row of
  `docs/extensions/README.md` are final-phase edits (shared E files those tasks did not claim); `tests/extensions-examples.test.mjs`
  cannot pass before they land.

## Uncovered-contract map

Contracts that no reference package exercises. Each is covered by a phase fixture or has a named decision; the "proof" column
is the fixture, not an installed result. All **written, not run**.

| Area | Contract not exercised by a package | Fixture or task that covers it | Falsifier (what would show it wrong) | Status |
|---|---|---|---|---|
| R3 remote-origin | Per-package remote origin, persistent storage per origin, remote page in a panel | R0302 `09d5989`; `sample.windows-panels` remote view and `remote/chart.html` in R0306 `e9029e8` | A panel on origin A reads origin B's storage or a remote page reaches the channel without `ui.richViews` | Prepared, not run; installed pending |
| R4 draft | `tasks.draft` without sending | R0403 `4625631` (doc `runtime-tasks-drafts.md`); usage uses it only as a checkpoint insert | A draft write sends or clears an unsaved user draft | Written, not run |
| R4 mode/workspace | `tasks.control` set mode/configure/compact, councils/workers, workspace settings, projects/worktrees/checks, bots/channels/recipes/moodboards/cloud, harness console | R0404 `19fe7dc`, R0404B `1b75873`, R0407 `cc8e585`, R0405 `c895c20`, R0406 `c5978b3`, R0406B `894c8a7`, R0406C `f97ce97`, R0408 `86616cb` | A write on an excluded key (telemetry, routing, trust, pairing) succeeds, or a stale revision applies | Written, not run |
| R4 terminal/guest | `terminals.read`/`terminals.write`, `guests.control` (VM, simulator, browser) | R0409 `87c8b9b`, R0410 `ef0247c` | `terminals.write` allowed with only `terminals.read`, or a guest control without its grant | Written, not run |
| R4 checks | `projects.checks.run` | R0405 | A check runs without the grant or outside the granted project | Written, not run |
| R5 approve/rewrite | `approve` (guard only denies and rewrites), late approve, ask, scoped full mode | R0505 `c920ad4`, R0508 `ac906c2` (`sample.late-responder`), R0506 `b92dfca` | A hook crash or timeout approves, or two hooks disagree and an approve beats a deny | Written, not run; live Claude capture pending |
| R6 package companion | Companion for hooks only the harness has (request transform, compaction) | **None: R0601-R0606 skipped, user decision 2026-11-17.** | n/a | **Pending - separate user design** |
| R7 tool server | Declared stdio/http tool servers attached per run | R0702 `c16381e`, R0703 `332e5b3` | A stdio server receives a held value, or a stale tool name survives | Written, not run; attachment pending provider seam; ZCode (A5) pending person decision |
| R8 held credentials | Held credential used without reading (header/query/bearer), account switching | R0805 `d9a5b77`, R0703 header on declared HTTP tool servers | A canary value appears in a package, process environment, log or panel | Written, not run |
| R10 presentation | Tool-row replacement, protected-dialog extras, transcript/working presentations | R1004 `69fe619`, R1003 `1880b29`, R1002 `28b8d5b` (spec only, no package) | A package softens a destructive chip or removes a refusal row | Written, not run; main.ts callbacks pending |

## S07C gap rows and handoffs: each consumed

| Gap | Result in this run | Evidence or decision |
|---|---|---|
| G1 picker model/effort/speed/mode not reaching the agent (F1) | **Partly closed.** R0807 passes model, effort and tier in `session/new` `_meta.pandacode` and records attributed events; `session/set_model` or config frames are still not sent, and mode is not confirmed | R0807 `f984809`; remaining part: F1 follow-up, see C1 below |
| G2 resume and history replay (F2, F3) | **Open follow-up.** B5 does not advertise `loadSession`; no replay task | follow-up; falsifier below |
| G3 live steering | Handed to R0402 `0d4436b`: unsupported steer is explicit | explicit `UnsupportedCapability` or queue-after, never a silent drop |
| G4 `{package}` with `runtime.files` (F4) | **Still open.** `launch.rs` resolves `{package}` only when the code folder exists; the join is not made | follow-up F4, see C3 |
| G5 `mcpServers` empty | R0701/R0702/R0703: contract and bridge done; per-run providers do not read `mcp_entries` yet | wiring pending |
| G6 limits/account rows | R0806 `80d8885` `panda.providers.update` | written, not run |
| G7 sign-in/credentials for a CLI | R0803, R0805, R0806 done; host-attached credential for a launched stdio CLI is F5, not built | follow-up F5, see C2 |
| G8 ACP question and compact frames (F6) | **Question:** R0501 changed `runtime_provider_launch` to decline a structured question instead of approving its first answer; mapping to the core question event and compact frames are not done | follow-up F6, see C4 |
| A1 token streaming (F7) | **Open follow-up** (R0804 JSON adapters only) | see C5 |
| A2 provider handler has no `panda` | R0806 acceptance (verify, not assumed) | written, not run |
| A3 SDK type for `connections` (F8) | The SDK declares an invocation-scoped `panda.connections` (status/start/poll/cancel); service-side typing to be confirmed by the final type-check | verify in final phase |
| A4 package tools to team workers | R0701/R0703/R1004 contracts; attachment pending provider seam | handed off |
| A5 package tools to ZCode MCP bridge | **Needs a person.** Not wired by R0701-R0703; ADR-0005 favours yes with a named permission, revocation and attribution, but the user decides | pending person decision |
| A6 Alibaba as a package | R0805 HTTP side done; stdio launch needs F5 plus an endpoint field | follow-up F5, see C2 |
| A7 installed/live qualification | Recorded here; installed column pending everywhere; macOS/Linux `UnsupportedRuntime` (R1102 `dccdd6f`) | pending human input |
| S0601-S0610 handoffs | Package explorer entries R0205, files R0405, editors R0301-R0306/R0901-R0903, rows R0701/R0502-R0506/R1004, image identity R1004/R0203, workers R0404B, tiers R0806/R0807, notices R0207/R0404B, restart R0106/R0403, usage roster R0204/R0407, placement R0108/R0401/R0404 | all implemented, tests not run; R0108 paired-machine proof pending (needs two real paired computers) |
| R0807 speed tiers / warm spares | Implemented: opt-in per package, off by default, bound to the executable digest, rechecked at every start | `f984809`, `docs/extensions/runtime-provider-speed.md`; installed pending |
| R0705 CLI intent | Contract implemented; annotate call sites unwired | `dec4df8` |
| R1004 built-in row and risk replacement | Contract implemented; destructive chip kept first; `main.ts` callbacks pending | `69fe619` |

## New missing adapters and contracts (operation, permission, owner, falsifier)

None of these is a refusal for security; none withholds a capability from a trusted package (ADR-0005). Permissions reuse the
decided vocabulary; where a new name would be needed it is stated as a decision, not invented. Owners are tasks to add or
existing owners to fold the work into; jtasks cannot add tasks to a finished run, so these are for a person to schedule.

| Id | Operation | Permission | Owner | Falsifier |
|---|---|---|---|---|
| C1 (F1) | Forward `session/set_model`/config frames (model, effort, speed tier, mode) from the picker to a declared ACP harness | none new (declared launch) | owner of `runtime_provider_launch.rs` after R0807 | `FAKE_AGENT_LOG` shows no frame for a chosen effort or mode |
| C2 (F5, A6, G7) | Host attaches a granted credential to a launched stdio CLI without the package or process reading it, plus a declared endpoint override | `credentials.use` (per item) | R8 owner after R0805 | The launched process environment or arguments contain the canary value, or the endpoint override is ignored |
| C3 (F4) | Resolve `{package}` in a launch command when the package declares `runtime.files` | none new | owner of `launch.rs` | `command: ["{node}","{package}/agent.mjs"]` still answers `UnsupportedRuntime` |
| C4 (F6) | Map ACP `question`/`compact` frames to the core question event and compaction, or say unsupported | none new | owner of `runtime_provider_launch.rs` | A question frame still ends as `UnsupportedCapability` |
| C5 (F7) | Connection adapter for server-sent streaming (chunks as `text` events, cancel, byte limit) | `connections.request` | R8 follow-up to R0804 | An SSE answer still returns `InvalidShape` |
| C6 (F2, F3) | B5 advertises `loadSession`; host replays ordered events after `session/load` | `tasks.control` | R0404 owner or a new R4 slice | A resume with a saved id replays an event twice or not at all |
| U1 | `panda.ui.notify` options: operating-system channel flag and a click action that reveals a view | `ui.notify` (action target through `ui.reveal` rules) | R0207 owner | Clicking an inbox notice does not open the inbox; an OS flag is ignored |
| U2 | Service call to create one new project file from a declared template and open it in a declared editor | `documents.editors` | R0903 owner (expose `NewFiles::create` to the service) | A service holding the grant cannot create a note; an existing file is overwritten instead of `Conflict` |
| U3 | Service call returning the granted project root (identity, not content) | `projects.files.metadata` | R0105/R0401 owner | A service still has to use its own working folder |
| W1 | Hidden-run path for `models.call` (a harness run without a session row, tools or hooks) | `models.call` | owner of `providers`/`lib.rs` | `sample.memory` capture still answers `UnsupportedCapability` with a signed-in harness |
| W2 | Provider paths read `mcp_entries` (tool servers and package tools in built-in harnesses) | `tools.model` | provider-seam owner | A launched harness lists no `pkg_*` tool |
| W3 | Call-site wiring: `runtime_cli_intent::annotate`, editor shell/new-file menu, `main.ts` row callbacks | existing | owners of those files | Rows listed in the wiring table keep saying "pending" after the final phase |
| A5 | Offer package tools to ZCode through the per-session MCP bridge | would be `tools.model` extended to a built-in harness | **Pending person decision** | Decision first; then ZCode lists and calls the package tool with a trace row naming the package |

## What stays out even after this run

- Rewriting each model request of a built-in harness from the host: reachable only through a companion inside that harness
  (C8), which is skipped and pending a separate user design.
- Anything a terminal draws inside a harness's own interface.
- Data that belongs to another host application.
- Per-core and process metrics: no PandaCode contract exposes them and none is proposed.
