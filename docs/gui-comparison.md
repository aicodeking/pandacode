# PandaCode compared with other coding-agent GUIs and CLIs

Researched on 2026-11-07. Products in this space change every week, so check each claim against its source before you repeat it. "Unknown" means this research did not find the information. It does not mean that the feature is missing. For open-source tools, source files are linked at the commit that was read.

Commits that were read:

- T3 Code: [`pingdotgg/t3code@25bf84ab`](https://github.com/pingdotgg/t3code/tree/25bf84ab07f53f141c20239c63e383823a9d5ea0)
- Vibe Kanban: [`BloopAI/vibe-kanban@08064e04`](https://github.com/BloopAI/vibe-kanban/tree/08064e043c2d78ad123b473257ed867e7ce74768)
- Claude Squad: [`smtg-ai/claude-squad@ce1ffb43`](https://github.com/smtg-ai/claude-squad/tree/ce1ffb4392b01f38e2c4599c7c84d2a93973b138)
- Crystal: [`stravu/crystal@1e18e0bc`](https://github.com/stravu/crystal/tree/1e18e0bc981225f75b5226f82a300fa741970c6f)
- OpenCode: [`anomalyco/opencode@c33eaa17`](https://github.com/anomalyco/opencode/tree/c33eaa170ed5093c08f1684862a695aae036dcda)

PandaCode facts come from this checkout: `README.md`, `AGENTS.md`, `docs/agent-tools.md` and the benchmark docs listed below.

## Two kinds of product

- **Harnesses** run the model loop and own the tools: Claude Code, Codex CLI, OpenCode, and Cursor's agent.
- **Control surfaces** start and display harnesses that are already installed: PandaCode, T3 Code, Conductor, Vibe Kanban, Claude Squad, Crystal, and Zed's external agents.

T3 Code's FAQ draws the same line: "T3 Code uses those harnesses. It is not a harness" ([faq.md](https://github.com/pingdotgg/t3code/blob/25bf84ab07f53f141c20239c63e383823a9d5ea0/docs/user/faq.md)).

This matters for speed and token use. A control surface can change only what the harness lets it change: launch flags, appended instructions, extra MCP tools, denied tools, and process reuse.

## Status notes

These notes, and the telemetry defaults below, are as reported by the cited sources on the stated dates; re-verify them before publishing.

- **Crystal** is deprecated (February 2026) and has been replaced by Nimbalyst ([README](https://github.com/stravu/crystal/blob/1e18e0bc981225f75b5226f82a300fa741970c6f/README.md)).
- **Vibe Kanban** is "sunsetting". Its company shut down, and the code continues under community maintenance ([README](https://github.com/BloopAI/vibe-kanban/blob/08064e043c2d78ad123b473257ed867e7ce74768/README.md), [announcement](https://vibekanban.com/blog/shutdown)).
- **Conductor** shows the banner "Conductor is joining Meta" (changelog 0.93.0, 2026-11-04, [conductor.build](https://www.conductor.build)).
- **Codex app**: OpenAI's docs now describe the Codex desktop app as part of the ChatGPT desktop app ([ChatGPT desktop app](https://developers.openai.com/codex/app.md)).

## Summary table

Short cells. The notes below the table give the details and the sources.

| | PandaCode | T3 Code | Claude Code (CLI + Desktop) | Codex (CLI + ChatGPT app) | Cursor agent | Conductor | OpenCode | Zed agent panel | Claude Squad | Vibe Kanban |
|---|---|---|---|---|---|---|---|---|---|---|
| Kind | Native desktop control surface (Tauri) | Control surface: server + web, Electron, mobile | Harness + desktop/web/mobile surfaces | Harness + desktop/mobile surfaces | Editor + own harness | Mac control surface + cloud | Harness (TUI, desktop beta, server) | Editor + own agent + ACP host | tmux TUI | Web control surface (local server) |
| Harnesses | ~20: Claude Code, Codex, Kimi, OpenCode, GLM/MiMo via Claude Code, ACP agents (Copilot, Grok, Devin, Cline…), Pi, ZCode, Muse | Claude Code, Codex, Cursor, Grok Build, OpenCode, Antigravity, Pi, Muse, Kiro, fx, ACP registry | Itself | Itself | Itself (many models) | Claude Code, Codex, Cursor, OpenCode | Itself (models.dev catalog) | Own agent + ACP agents (Claude, Codex, Gemini, OpenCode…) | Any terminal CLI | 10+ CLIs |
| Adds a system prompt | Yes: short app instructions (titles, run script, change tracking, turn-end rule, optional explore/tool hints) | Yes: runtime info, PR linking, orchestration sections | n/a | n/a | n/a (owns prompt) | Yes (FAQ) | n/a | Unknown for ACP agents | No (runs the CLI as is) | Optional user "append prompt" on the message |
| Extra tools given to agent | PandaCode MCP: explore, title, track files, schedules, team tools, VM/simulator, design, agent-made tools | T3 MCP: `delegate_task`, thread/worktree/project/preview/device tools | n/a | n/a | n/a | Unknown | n/a | Unknown | None | Optional MCP server (task/issue tools) |
| Parallel + worktrees | Yes, per-task worktrees | Yes | Desktop sessions with Worktree toggle; CLI `--worktree` | Yes (worktrees, background worktrees) | Agents Window worktrees; Cloud Agents | Yes, one worktree per workspace; cloud microVMs | Unknown (sessions; no worktree feature found) | Parallel threads; linked worktrees | Yes (tmux + worktree) | Yes (workspaces) |
| Teams / sub-agents | Architect + workers across harnesses (unlimited in parallel by default, or a set cap); native subagents shown | `delegate_task` across providers; native subagents | Subagents; experimental agent teams | Subagents | Subagents, Explore subagent, Projects coordinator | Uses Claude agent teams (env var) | Subagents (`mode: subagent`) | Unknown | No | No |
| Model routing | Local router for team workers (Cheap/Balanced/Best) | No (FAQ suggests external proxy) | No | No | Cursor Router (Auto; Teams/Enterprise) | No | No | No | No | Claude Code Router option |
| Code search for agent | `pandacode_explore` (local index, read-only) | None added | Harness built-ins | Harness built-ins | Instant Grep, Explore subagent | None found | grep/glob, LSP diagnostics | Unknown | None | None |
| Usage / cost display | Per-harness limits and cost estimates | Usage view across providers, cache savings | Session cost, cache stats | Unknown in app | Plan usage pools | Unknown | Unknown | Token count per thread | No | Unknown |
| Queue / steer | Queue (Enter) + steer (⌘Enter) | Queue or steer setting | Queue; Ctrl+Enter sends queued now | Steer (Enter) / queue (Tab) in CLI | Unknown | Unknown | Unknown | Queue; "Send now" | Typing into the tmux pane | Unknown |
| Remote / mobile | Opt-in E2E relay + mobile app; cloud agents; bots | T3 Connect, iOS/Android, web | Remote Control, Claude mobile/web | ChatGPT mobile to connected computer or Cloud | iOS app, web, Slack, GitHub | Mobile, API, cloud | Server mode | No | No | Was cloud; now local only |
| Telemetry | None of its own | Product events on by default (opt-out env var) | Metrics on by default (opt-out) | statsig analytics (opt-out) | Unknown for editor; Privacy Mode for training | PostHog analytics | Unknown | Opt-out client telemetry | None found | PostHog, `analytics_enabled` default true |
| Licence | PandaCode License (MIT + fork credit) | MIT | Proprietary | CLI Apache-2.0; app proprietary | Proprietary | Proprietary | MIT | GPL-3.0 / Apache-2.0 files | AGPL-3.0 | Apache-2.0 |
| Price | Free | Free; T3 Connect free up to 3 machines | Claude subscription or API | ChatGPT plan or API | $0–$200/mo plans | Free (FAQ: "Right now we don't" make money) | Free; pay model provider | Free; Pro adds hosted models | Free | Free (open source) |

## Notes by dimension

### Harnesses supported

- **PandaCode**:
  - Claude Code, Codex, Kimi Code, OpenCode, GLM and MiMo (through Claude Code).
  - Through ACP: Copilot CLI, Antigravity, Grok Build, DeepSeek, Command Code, Cline, Kilo Code, Devin CLI and Hermes.
  - ZCode, Pi/omp and Muse Code.
  - Source: `README.md`.
- **T3 Code**: Codex, Claude, Cursor, Grok Build, OpenCode, Antigravity and fx ([README](https://github.com/pingdotgg/t3code/blob/25bf84ab07f53f141c20239c63e383823a9d5ea0/README.md)). Its FAQ also lists Pi and Muse, and the repo has `provider-kiro` and an ACP registry package ([faq.md](https://github.com/pingdotgg/t3code/blob/25bf84ab07f53f141c20239c63e383823a9d5ea0/docs/user/faq.md), [packages/](https://github.com/pingdotgg/t3code/tree/25bf84ab07f53f141c20239c63e383823a9d5ea0/packages)). T3 has no local-model support: "Locally runnable models are not capable of meaningful engineering work" (FAQ).
- **Conductor**: Claude Code, Codex, Cursor and OpenCode. It bundles its own copies of Claude Code and Codex ([docs](https://www.conductor.build/docs/index), [FAQ](https://www.conductor.build/docs/faq)).
- **Zed**: its own agent, plus external agents over ACP from the ACP Registry (Claude Agent, Codex, and others) ([external agents](https://zed.dev/docs/ai/external-agents)).
- **Claude Squad**: any CLI, run in tmux (Claude Code, Codex, Gemini, Aider…) ([README](https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/README.md)).
- **Vibe Kanban**: Claude Code, Codex, Gemini CLI, Copilot, Amp, Cursor, OpenCode, Droid, CCR and Qwen Code ([README](https://github.com/BloopAI/vibe-kanban/blob/08064e043c2d78ad123b473257ed867e7ce74768/README.md)).
- **OpenCode** is itself a harness. It takes models from the models.dev catalog ([providers](https://opencode.ai/docs/providers)).
- **Cursor**: its own agent, with Cursor, OpenAI, Anthropic, Google and xAI models ([models and pricing](https://cursor.com/docs/models-and-pricing)).

### How each tool launches the agent

This is the dimension that most affects speed and tokens.

**PandaCode (Claude Code)** ([`src-tauri/src/providers.rs`](../src-tauri/src/providers.rs), `app_instructions` in [`src-tauri/src/app_instructions.rs`](../src-tauri/src/app_instructions.rs)):

- **Process.** One `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --replay-user-messages` process runs per turn. It uses `--permission-prompt-tool stdio`, maps the mode to `--permission-mode` (`acceptEdits`/`auto`/`plan`/`bypassPermissions`/`default`), and resumes with `--resume`.
- **App instructions.** They are passed once as `--append-system-prompt`, so they sit in the cached prefix. They cover:
  - sidebar titles
  - `pandacode-run.sh`
  - turn-change tracking
  - a "your turn ends when you reply" rule
  - when explore is on, the `LOOK` line: "Use pandacode_explore to locate code … with all your questions in one call"
  - agent-made tool hints
- **Instructions for other harnesses.** Harnesses without a system prompt (all but Claude Code, GLM, MiMo, Pi and OMP) get them in the message on a new conversation and every 8th turn.
- **Per-message notes.** Short notes can still ride a message: a title note, a Plan-mode note, a 160 B edit-tracking note (only when native edits wait for approval) and the Project tools note (first message, on change, a fresh conversation, every 8th) (`lib.rs`, `app_instructions.rs`).
- **Denied tools.** `--disallowedTools` removes `ScheduleWakeup,Monitor,CronCreate`, because the process ends with the turn. Team workers also lose `Agent`, `Task`, `Workflow`, `SendMessage`, worktree tools and more. `Skill` stays on for workers by default; it is denied only when the user turns Settings → Agents → Workers can use skills off (`docs/worker-tokens.md`).
- **MCP tools.** They are attached with `--mcp-config`.
- **Warm processes.** After a successful Claude turn, PandaCode starts the next turn's process in the background: 2 ordinary spares for 10 idle minutes, plus a separate pool of up to 2 for team leads waiting on their workers, which ordinary tasks never evict. An expired lead spare restarts at most 2 times while its workers still run and none waits on the user, and it is dropped when the task stops or its team is paused or stopped. A follow-up reuses a spare only when model, mode, effort, folder, resume ID, instructions, tool catalog and worker trim (opt-in, off by default: Settings → Agents → Trim worker tools, the `worker-trim-on` marker) all match (`AGENTS.md`, `providers/warm.rs`).

**T3 Code (Claude)** ([`ClaudeAdapterV2.ts`](https://github.com/pingdotgg/t3code/blob/25bf84ab07f53f141c20239c63e383823a9d5ea0/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts), around lines 1770–1890):

- **Process.** T3 drives Claude Code through the Claude Agent SDK `query()`, with `systemPrompt: {type: "preset", preset: "claude_code", append: …}`, `includePartialMessages`, a `canUseTool` callback for approvals, and the session's permission mode.
- **Appended text.** Each session gets:
  - `<runtime_info>` (harness, model, effort)
  - `<pull_request_linking>` rules ([`runtimeInstructions.ts`](https://github.com/pingdotgg/t3code/blob/25bf84ab07f53f141c20239c63e383823a9d5ea0/packages/provider-core/src/server/runtimeInstructions.ts))
  - when T3's MCP server is attached, about 3 KB of "T3 Code orchestration" sections and a background-wait note ([`orchestrationInstructions.ts`](https://github.com/pingdotgg/t3code/blob/25bf84ab07f53f141c20239c63e383823a9d5ea0/packages/provider-core/src/server/orchestrationInstructions.ts))
- **Tool loading.** The instructions say that "T3 MCP tools are deferred: load one with ToolSearch". So T3 relies on Claude Code's deferred tool loading and does not list its tools up front.
- **MCP tools** (from [`apps/server/src/mcp/toolkits`](https://github.com/pingdotgg/t3code/tree/25bf84ab07f53f141c20239c63e383823a9d5ea0/apps/server/src/mcp/toolkits)):
  - `delegate_task`, `orchestrator_capabilities`, `task_status`, `task_cancel`
  - `t3_thread_*`, `t3_worktree_*`, `t3_project_*`, `t3_background_wait`
  - preview, device and HTML render tools
  - No code-search tool was found.
- **ACP harnesses.** ACP has no system field, so T3 injects the instructions into the first prompt and again when tools or mode change (same file).
- **Thinking summaries.** T3 asks for summarized adaptive thinking by default.
- **Known issue.** T3's FAQ says that Agent SDK usage drains Claude's 5-hour limit faster than direct Claude Code use. It calls this an Anthropic-side bug ([faq.md](https://github.com/pingdotgg/t3code/blob/25bf84ab07f53f141c20239c63e383823a9d5ea0/docs/user/faq.md)). This research did not verify the claim.

**Conductor** (closed source, from its [FAQ](https://www.conductor.build/docs/faq)):

- It "injects system prompts that explain to the agent that it's running inside Conductor", plus action prompts. You can view and edit them in Settings → repository → Actions.
- Agents "run directly on your system without sandboxing".
- It bundles pinned Claude Code and Codex binaries.
- The exact flags and tools are unknown.

**Vibe Kanban** ([`crates/executors/src/executors/claude.rs`](https://github.com/BloopAI/vibe-kanban/blob/08064e043c2d78ad123b473257ed867e7ce74768/crates/executors/src/executors/claude.rs)):

- Runs `npx -y @anthropic-ai/claude-code@2.1.119` with the same stream-json flags as PandaCode (including `--replay-user-messages`), plus `--permission-prompt-tool=stdio`, `--disallowedTools=AskUserQuestion` in plan/approval modes, and optional `--dangerously-skip-permissions`.
- It can run Claude Code Router instead.
- An optional user "append prompt" is concatenated onto the user message, not the system prompt (`combine_prompt` in [`executors/mod.rs`](https://github.com/BloopAI/vibe-kanban/blob/08064e043c2d78ad123b473257ed867e7ce74768/crates/executors/src/executors/mod.rs)).

**Crystal** ([`claudeCodeManager.ts`](https://github.com/stravu/crystal/blob/1e18e0bc981225f75b5226f82a300fa741970c6f/main/src/services/panels/claude/claudeCodeManager.ts)): adds its own MCP server and routes approvals through it (`--permission-prompt-tool mcp__crystal-permissions__approve_permission`).

**Claude Squad** ([`session/tmux/tmux.go`](https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/session/tmux/tmux.go)):

- Starts the unmodified interactive CLI with `tmux new-session -d -s <name> -c <worktree> <program>`.
- Adds no prompt and no tools.
- `--autoyes` auto-accepts prompts.

**Zed**: external agents "manage their own auth, models, and tools" over ACP ([external agents](https://zed.dev/docs/ai/external-agents)). What Zed adds to them is unknown.

**Claude Code, Codex, OpenCode, Cursor** own their prompts and tools, so this dimension does not apply to them.

### Parallel agents and worktrees

- **PandaCode**: parallel tasks across projects, per-task worktrees with a local Merge into main, and a board (`README.md`, `docs/worktrees.md`).
- **T3 Code**: "New worktree" threads and automatic worktree cleanup ([thread-sidebar.md](https://github.com/pingdotgg/t3code/blob/25bf84ab07f53f141c20239c63e383823a9d5ea0/docs/user/thread-sidebar.md), [faq.md](https://github.com/pingdotgg/t3code/blob/25bf84ab07f53f141c20239c63e383823a9d5ea0/docs/user/faq.md)).
- **Claude Code**:
  - The Desktop runs parallel sessions with a per-session Worktree toggle, off by default ([desktop](https://code.claude.com/docs/en/desktop)).
  - The CLI has `claude --worktree` ([common workflows](https://code.claude.com/docs/en/common-workflows)).
- **Codex**: worktrees, and scheduled tasks on background worktrees ([worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees.md)).
- **Cursor**: worktrees in the Agents Window, set up with `.cursor/worktrees.json` ([worktrees](https://cursor.com/docs/configuration/worktrees)). Cloud Agents run in VMs ([cloud agents](https://cursor.com/docs/cloud-agent)).
- **Conductor**: one workspace (worktree, branch, terminal, diff) per task, plus cloud microVM workspaces ([docs](https://www.conductor.build/docs/index), [security](https://www.conductor.build/docs/reference/security-and-permissions)).
- **Zed**: parallel threads in a Threads Sidebar, with linked Git worktrees ([parallel agents](https://zed.dev/docs/ai/parallel-agents)).
- **Claude Squad**: a worktree and a tmux session for each instance.
- **Vibe Kanban**: a workspace (branch, terminal, dev server) for each issue.
- **OpenCode**: no worktree feature was found in its docs (unknown).

### Team and sub-agent orchestration

- **PandaCode**:
  - An architect with workers (unlimited in parallel by default, or a set cap) that can mix harnesses and models, or named team profiles ([`docs/architect-workers.md`](architect-workers.md)).
  - Workers can get a reduced tool set (worker trim, opt-in and off by default; see launch).
  - The lead can give workers token-saver packs.
- **T3 Code**: `delegate_task` to another provider or model, optionally in a worktree. Native subagents are used when the child uses the same provider (`orchestrationInstructions.ts`).
- **Claude Code**:
  - Subagents ([sub-agents](https://code.claude.com/docs/en/sub-agents)).
  - Agent teams, which are "experimental and disabled by default" ([agent teams](https://code.claude.com/docs/en/agent-teams)).
- **Codex**: subagents and custom agents. The docs say that they "consume more tokens than comparable single-agent runs" ([subagents](https://developers.openai.com/codex/subagents.md)).
- **Cursor**: subagents, an automatic Explore subagent "with a faster model", and Projects with a coordinator agent ([agent](https://cursor.com/docs/agent/overview), [search](https://cursor.com/docs/agent/tools/search)).
- **Conductor**: can turn on Claude Code agent teams through an environment variable ([FAQ](https://www.conductor.build/docs/faq)).
- **OpenCode**: subagents with `mode: subagent` ([agents](https://opencode.ai/docs/agents)).

### Model routing

- **PandaCode**:
  - A local router (an ONNX profiler plus a matcher) picks worker models in automatic teams (Cheap, Balanced or Best).
  - It escalates when a worker fails.
  - It never sends the task anywhere.
  - Source: `README.md`, [`docs/model-routing.md`](model-routing.md).
- **Cursor**: Cursor Router behind Auto. It is a classifier on each request, "currently only available on Teams and Enterprise plans" ([Cursor Router](https://cursor.com/docs/cursor-router)).
- **Vibe Kanban**: can launch Claude Code through Claude Code Router (`claude.rs`).
- **T3 Code**: no router. The FAQ points to an external proxy for account pools.
- **The other tools**: none found.

### Code search or indexing given to the agent

- **PandaCode**: `pandacode_explore` is one read-only call for search, definitions, outlines, ranged reads and test lookup. It uses a local index, refuses secret files, and is on by default with a Settings switch ([`docs/agent-tools.md`](agent-tools.md)).
- **Cursor**:
  - Instant Grep, a local index that is "faster than ripgrep on large codebases" by Cursor's account.
  - An Explore subagent.
  - The current search page says that Cursor "does not store embeddings of your codebase for search" ([search](https://cursor.com/docs/agent/tools/search)).
- **OpenCode**: grep/glob tools ([tools](https://opencode.ai/docs/tools)), and LSP diagnostics "as feedback for the agent" ([LSP docs source](https://github.com/anomalyco/opencode/blob/c33eaa170ed5093c08f1684862a695aae036dcda/packages/web/src/content/docs/lsp.mdx)).
- **T3 Code, Conductor, Claude Squad, Vibe Kanban**: no search tool added. The agent uses its harness's built-ins.

### Token and cost controls, usage display

- **PandaCode**:
  - Per-harness limits and cost estimates ([`docs/agent-usage.md`](agent-usage.md)).
  - Per-task token-saver response-style packs.
  - Leaner worker launches (see the measured results).
- **T3 Code**:
  - A Usage view across providers with "token use, cache savings, model breakdowns, and estimated API-equivalent cost" ([usage.md](https://github.com/pingdotgg/t3code/blob/25bf84ab07f53f141c20239c63e383823a9d5ea0/docs/user/usage.md)).
  - An auto-compact threshold for Claude.
  - A Compact chip after the prompt cache expires ([providers-claude.md](https://github.com/pingdotgg/t3code/blob/25bf84ab07f53f141c20239c63e383823a9d5ea0/docs/user/providers-claude.md)).
- **Claude Code**: session cost and "Prompt cache (main)" statistics ([costs](https://code.claude.com/docs/en/costs)).
- **Zed**: a token count per thread, and compaction for its own agent ([agent panel](https://zed.dev/docs/ai/agent-panel)).
- **Cursor**: usage pools by plan ([models and pricing](https://cursor.com/docs/models-and-pricing)).
- **Conductor, OpenCode, Vibe Kanban, Claude Squad**: unknown.

### Prompt caching awareness

- **PandaCode** puts fixed instructions in `--append-system-prompt`, so they are cached with the prefix. Per-message notes (title, Plan mode, edit tracking, Project tools) are short and conditional. Harnesses without a system prompt get the instructions again only every 8th turn (`AGENTS.md`).
- **T3 Code**:
  - Appends a session-invariant block. Its comment says that the PR-linking text "can carry it once per session" (`runtimeInstructions.ts`).
  - Shows cache savings in Usage.
  - Offers compaction after the cache expires.
- **Claude Code** documents what invalidates its cache and orders requests for prefix reuse ([prompt caching](https://code.claude.com/docs/en/prompt-caching)).
- **The other tools**: unknown.

### Queue and steering

- **PandaCode**: Enter queues and ⌘/Ctrl+Enter steers. Steering is live on Claude-family, Codex, Pi and OpenCode. Otherwise it is held for the next turn (`AGENTS.md`).
- **T3 Code**: a per-client setting to queue or steer, with a shortcut for the opposite action. Queued messages are saved on the server ([composer.md](https://github.com/pingdotgg/t3code/blob/25bf84ab07f53f141c20239c63e383823a9d5ea0/docs/user/composer.md)).
- **Claude Code CLI**: Enter queues while Claude works, and Ctrl+Enter sends the queue now ([interactive mode](https://code.claude.com/docs/en/interactive-mode)).
- **Codex CLI**: Enter steers and Tab queues. This comes from third-party guides only ([reference](https://codex.danielvaughan.com/2026/04/08/codex-cli-tui-shortcuts-slash-commands/)). It is not verified in OpenAI's docs.
- **Zed**: queues by default and has "Send Now" ([agent panel](https://zed.dev/docs/ai/agent-panel)).
- **Cursor, Conductor, OpenCode, Vibe Kanban**: unknown.

### Remote and mobile access

- **PandaCode**:
  - Opt-in PandaCode Connect. It is an end-to-end encrypted relay with no network traffic until GitHub sign-in, and a mobile viewer/controller app ([`docs/remote-access.md`](remote-access.md)).
  - Cloud agents in your own provider account, a headless `pandacode serve`, and chat bots.
- **T3 Code**: T3 Connect (free up to 3 machines; more with paid T3 Chat), LAN, Tailscale, a web app and iOS/Android apps ([remote-access.md](https://github.com/pingdotgg/t3code/blob/25bf84ab07f53f141c20239c63e383823a9d5ea0/docs/user/remote-access.md)).
- **Claude Code**: Remote Control from claude.ai/code and the Claude mobile app ([remote control](https://code.claude.com/docs/en/remote-control)).
- **Codex**: ChatGPT mobile to Cloud or to a connected Mac/PC ([Codex on mobile](https://developers.openai.com/codex/mobile.md)).
- **Cursor**: an iOS app, the web, Slack, GitHub, Linear and an API, for Cloud Agents ([cloud agents](https://cursor.com/docs/cloud-agent)).
- **Conductor**: mobile, an API and cloud ([conductor.build](https://www.conductor.build)).
- **Zed, Claude Squad**: none found.

### Review and diff UI

- **PandaCode**:
  - Saved per-turn changes with unified/split diffs.
  - Staging and commits.
  - PR tabs and a GitHub view (`README.md`).
- **T3 Code**: per-turn diffs, a commit picker, and PR review on several code hosts ([source-control.md](https://github.com/pingdotgg/t3code/blob/25bf84ab07f53f141c20239c63e383823a9d5ea0/docs/user/source-control.md)).
- **Claude Code Desktop**: a diff view with comments, a Code review card and PR monitoring ([desktop](https://code.claude.com/docs/en/desktop)).
- **Codex**: mobile diff review ([mobile](https://developers.openai.com/codex/mobile.md)) and code review ([code review](https://learn.chatgpt.com/docs/code-review.md)).
- **Conductor**: a diff viewer with line comments sent to the agent, plus GitHub comments and checks ([diff viewer](https://www.conductor.build/docs/reference/diff-viewer)).
- **Zed**: a multi-buffer Review Changes view with keep/reject per hunk ([agent panel](https://zed.dev/docs/ai/agent-panel)).
- **Cursor**: checkpoints ([agent](https://cursor.com/docs/agent/overview)).
- **Vibe Kanban**: inline diff comments ([README](https://github.com/BloopAI/vibe-kanban/blob/08064e043c2d78ad123b473257ed867e7ce74768/README.md)).
- **Claude Squad**: a preview of changes before apply ([README](https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/README.md)).

### Privacy and telemetry

- **PandaCode**:
  - No telemetry, analytics or accounts.
  - One switch starts every agent with its vendor's telemetry opt-outs and `DO_NOT_TRACK=1`.
  - Automatic requests (update checks and similar) are listed in the README.
- **T3 Code**:
  - Product events go to `ingest.t3.codes` and are forwarded to PostHog. They include provider, model, effort, permission mode, durations, token counts and hashed account IDs, but no prompts or code.
  - Relay traces go to Axiom.
  - Opt out with `T3CODE_TELEMETRY_ENABLED=false`.
  - Mobile crash reports have their own toggle.
  - Source: [telemetry.md](https://github.com/pingdotgg/t3code/blob/25bf84ab07f53f141c20239c63e383823a9d5ea0/docs/user/telemetry.md).
- **Claude Code**: metrics are on by default. Turn them off with `DISABLE_TELEMETRY=1` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` ([data usage](https://code.claude.com/docs/en/data-usage)).
- **Codex CLI**: has a statsig analytics exporter, turned off with `[analytics]` in its config. OTel export is opt-in ([advanced config](https://developers.openai.com/codex/config-advanced.md)).
- **Conductor**: PostHog analytics (features used, model, errors, OS, IP). Local chats stay on the Mac ([privacy](https://www.conductor.build/docs/reference/privacy)).
- **Zed**: client telemetry that you can turn off in settings ([telemetry](https://zed.dev/docs/telemetry)).
- **Vibe Kanban**: PostHog, and `analytics_enabled` defaults to `true` ([config v8](https://github.com/BloopAI/vibe-kanban/blob/08064e043c2d78ad123b473257ed867e7ce74768/crates/services/src/services/config/versions/v8.rs)).
- **Cursor**: Privacy Mode keeps code out of training ([privacy and data governance](https://cursor.com/docs/enterprise/privacy-and-data-governance)). Editor telemetry is unknown.
- **OpenCode**: unknown.
- **Claude Squad**: no telemetry code was found in a grep of the repo. This is not verified.

### Licence and price

| Tool | Licence | Price |
|---|---|---|
| PandaCode | MIT with a fork-credit clause (`LICENSE`) | Free |
| T3 Code | MIT | Free ([faq.md](https://github.com/pingdotgg/t3code/blob/25bf84ab07f53f141c20239c63e383823a9d5ea0/docs/user/faq.md)) |
| Claude Code | "All rights reserved" ([LICENSE.md](https://github.com/anthropics/claude-code/blob/main/LICENSE.md)) | Needs a Claude subscription or API |
| Codex CLI | Apache-2.0 ([LICENSE](https://github.com/openai/codex/blob/main/LICENSE)) | Plans on [pricing](https://developers.openai.com/codex/pricing.md) |
| Cursor | Proprietary | Free, $8, $30, $100 or $200 a month ([models and pricing](https://cursor.com/docs/models-and-pricing)) |
| Conductor | Proprietary | Free ("Right now we don't" make money, [FAQ](https://www.conductor.build/docs/faq)) |
| OpenCode | MIT | Free |
| Zed | GPL-3.0 and Apache-2.0 files in the repo ([zed](https://github.com/zed-industries/zed)) | Free; Pro adds hosted models and token credit ([plans](https://zed.dev/docs/ai/plans-and-usage)) |
| Claude Squad | AGPL-3.0 | Free |
| Vibe Kanban | Apache-2.0 | Free |
| Crystal | MIT | Free |

## PandaCode's measured results

All of these were measured on Claude Code with Sonnet. Other harnesses and models were not tested.

- **`pandacode_explore`** (batch Fv2, [`agent-loop-benchmark.md`](agent-loop-benchmark.md)):
  - On localization tasks, steps fell 12% (Holm p = 0.005) and wall time fell 14%.
  - Edits held: the edit pass gates passed.
  - Cost was not shown to be lower.
  - Caveats: the engine was tuned on the same 20 localization tasks. Tuned precision did not pass its non-inferiority gate. BEFORE had no Grep/Glob tools.
- **Round-18 worker launch** (batch S3, [`worker-tokens-benchmark.md`](worker-tokens-benchmark.md)):
  - About $0.037 saved per worker run (95% CI $0.034–$0.040), a −20.5% ratio of means.
  - It was measured with a copy of a large real skills library loaded. 91% of the saving is the first-step cache write; the arms differed in three ways (`Skill` denied, the MCP server's agent-made tools, `REUSE`), so `Skill`'s own share is not isolated.
  - It applies only when the user turns worker skills off: by default `Skill` stays on for workers.
  - The −20.5% applies only to a real skills library. There is no measured saving with a small one: batch S3b, which tested that case, is void and has no result.
- **Lead-chosen token-saver packs** (S1v3, [`token-saver.md`](token-saver.md)): no saving.
- **Agent-made tools** (pilot R1): unused in testing. No agent saved or ran a tool in 12 runs, so reuse was never tested.

No other tool in this comparison publishes a comparable controlled benchmark of its launch changes. One exception is Cursor's statement that semantic search plus grep answers codebase questions more accurately than grep alone, which a third-party mirror quotes. The current Cursor search page does not repeat it.

## Where PandaCode is ahead, behind, and unknown

**Ahead (documented features that the others lack or that this research did not find in them):**

- The most harnesses in one GUI. T3 Code is closest.
- No product telemetry of its own, and one switch for vendor opt-outs. T3 Code, Conductor, Vibe Kanban and Claude Code all send analytics by default.
- A local code-search tool given to every supported harness, with a published, pre-registered benchmark.
- A local model router for team workers. Cursor Router is the only other router found, and only on Teams/Enterprise.
- Teams across different harnesses, with an optional lighter launch for workers (worker trim, off by default).
- Warm-process reuse for Claude turns.
- Cloud agents in the user's own provider account, VMs, simulators and chat bots.

**Behind or equal:**

- Remote access: T3 Code, Claude Code, Codex and Cursor all have a web client and mobile apps. PandaCode's remote access needs a desktop host, with a mobile viewer. T3 Code's remote setup (`t3 up`, a background service, LAN/Tailscale) is broader.
- Usage display: T3 Code shows cache savings and per-model cost trends across providers. PandaCode's usage view shows limits and cost estimates. Whether it shows cache hit rates is not confirmed here.
- Diff review: Conductor and Claude Code Desktop send line comments back to the agent. That was not confirmed for PandaCode in this research.
- Cursor and Zed are full editors. PandaCode has file previews, not an editor.
- Single-harness depth: Claude Code Desktop and the Codex/ChatGPT app integrate features that their own vendors control.

**Unknown:**

- What Conductor injects, in exact text and size.
- What Zed adds to ACP agents.
- Cursor's editor telemetry.
- Steering in Cursor, Conductor and OpenCode.
- OpenCode's telemetry.
- Whether T3 Code's Agent SDK limit-drain claim is true.

## Launch differences a fair benchmark should replicate

These can change steps, latency or tokens for the same harness and model. A benchmark that compares GUIs should run each tool's real launch, or replicate it exactly.

1. **Appended system text and its size.**
   - PandaCode: short app instructions, plus `LOOK` when explore is on.
   - T3 Code: runtime info, PR linking, about 3 KB of orchestration text when its MCP server is attached.
   - Conductor: its own prompts (contents unknown).
   - Vibe Kanban, Claude Squad: none.

   Every extra token is a cache write on the first step and a cache read on every later step.
2. **Where the text goes.**
   - The system prompt is cached once: PandaCode, T3 Code.
   - A user-message append costs again on each send: Vibe Kanban.
   - First prompt and mode changes: T3 Code on ACP.
   - Every 8th turn: PandaCode on harnesses without a system prompt (all but Claude Code, GLM, MiMo, Pi and OMP).
3. **Extra MCP tools and how they load.** Listed tools add schema tokens on every step. Tools loaded through ToolSearch add a lookup step but keep the prefix small; T3 Code relies on this. PandaCode's batch S3 measured about $0.037 per worker run for a bundle of changes (`Skill` denied, `TaskStop` restored, agent-made tools and `REUSE` dropped) with a real skills library; `Skill`'s own share was not isolated.
4. **Denied tools.** PandaCode removes `ScheduleWakeup`, `Monitor` and `CronCreate` for everyone, and a longer list for workers (plus `Skill` only when the user turns worker skills off). Vibe Kanban removes `AskUserQuestion` in some modes. This changes both prompt size and agent behaviour.
5. **A search tool given to the agent.** `pandacode_explore` changed step counts in PandaCode's benchmark. A baseline needs the same built-in tools: PandaCode's BEFORE arm had no Grep/Glob.
6. **Process model.**
   - SDK `query()`: T3 Code.
   - One `claude -p` per turn, optionally pre-warmed: PandaCode.
   - A long-lived interactive TUI: Claude Squad.
   - A pinned bundled CLI version: Conductor, and Vibe Kanban's `@anthropic-ai/claude-code@2.1.119`.

   Startup time and CLI version both affect wall time.
7. **Thinking and effort defaults.** T3 Code asks for summarized adaptive thinking by default. PandaCode passes `--effort` only when it is set.
8. **Permission mode.** T3 Code's initial default is Full access ([permission-modes.md](https://github.com/pingdotgg/t3code/blob/25bf84ab07f53f141c20239c63e383823a9d5ea0/docs/user/permission-modes.md)). Conductor runs unsandboxed. Approval prompts add wall time in supervised modes.
9. **Compaction settings.** T3 Code has a custom auto-compact window. Zed compacts its own agent.
10. **Agent SDK as the entry point.** If T3 Code's limit-drain claim holds, quota use differs from direct CLI use even when tokens are equal.
