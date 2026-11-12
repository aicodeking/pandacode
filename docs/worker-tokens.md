# Where a team worker's tokens go

Batch S1v3 ([token saver benchmark](token-saver-benchmark.md)) showed the token saver packs save nothing measurable: output is about 1% of a worker's tokens. This page finds where the rest goes, picks one lever, builds it, and measures it (batch S2).

## Breakdown

Sonnet workers in Claude Code 2.1.317. Dollars use the prices `metrics.mjs` fits to billed costs: cache write $4/M, cache read $0.10/M, output $10/M.

| Batch | Runs | Steps | Billed | First-step write | Later writes | Cache reads | Output |
|---|---:|---:|---:|---:|---:|---:|---:|
| S1v3 | 340 | 4.2 | $0.157 | 25.3k tok, **$0.101** | 6.2k, $0.025 | 144k, $0.014 | 1.7k, $0.017 |
| Fv2 | 240 | 5.4 | $0.144 | 18.5k tok, **$0.074** | 7.7k, $0.031 | 193k, $0.019 | 2.0k, $0.020 |

**Cache writes are 80% of a worker's cost in S1v3 and 73% in Fv2, and the first step's write alone is 64% and 51%.** Cache reads are 81% (S1v3) to 87% (Fv2) of the tokens (reads / (writes + reads + output)) but under 15% of the cost.

### What the first request holds

We captured one real request through a local proxy and probed the pinned harness with different flags (`claude -p "Reply with the single word ok"` in a fresh git folder, first-request usage):

1. **Tools and the static system prompt** come first. Claude Code marks the system prompt with a 1-hour cache breakpoint, so this prefix (10–12.7k tokens with the default tools) is shared by every run on the account. It is a cache **read** every step, not a write.
2. **The first user message** holds the project's memory files (CLAUDE.md, AGENTS.md, user rules), the user context, then the task.
3. **A trailing environment block** holds the working folder, the deferred-tool list, the agent types, the skill listing and the date. Its end carries the only message breakpoint.

There is no breakpoint between the memory and the per-run parts, so **every worker writes the project memory again**, even when every worker in the team has the same files. The PandaCode `AGENTS.md` measured about 38.4 KB on 2026-11-10 (71,970 B in the last release commit). It was 28.7k tokens on the larger copy these runs used, and the token count has not been measured again since it shrank. By repo, S1v3's first-step write on those copies is 34k (PandaCode), 8k (Outline) and 4.5k (VS Code). The memory is the largest single cost, and it is the user's.

| Probe (no project memory, `--setting-sources project`, warm second run) | Tools | Prefix tokens | Written fresh per run |
|---|---:|---:|---:|
| Default tools | 23 | 15.9k | 3.4k |
| App's launch today (`ScheduleWakeup,Monitor,CronCreate` off), S2's BASE | 20 | 14.2k | 3.3k |
| Worker trim, writer | 10 | 9.4k | 2.7k |
| Worker trim, read-only, S2's LEAN | 7 | 8.8k | 2.7k |
| Worker trim, read-only, and `Skill` off | 6 | 5.9k | 0.4k |
| No tools (`--tools ""`) | 0 | 1.8k | 1.8k |

With the user's own settings (here: about 60 installed skills and a SessionStart hook), the trailing block is 37.9k characters, and **the skill listing alone is about 8k tokens written by every worker**. The read-only trim takes the prefix from 28.9k to 23.6k, and also turning `Skill` off takes it to 12.1k.

### Levers tried and dropped

- **Move the memory into the cached system prompt** (`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` plus `--append-system-prompt`). The appended copy was read from cache by the second run (38.7k read), but 2.1.317 still loads AGENTS.md through its built-in `cc-plugin-agents-md` plugin, so the memory was sent twice. Rebuilding Claude Code's memory discovery (ancestors, `.claude/rules`, imports, CLAUDE.local.md, AGENTS.md) by hand would risk dropping user rules without anyone noticing. Not safe.
- **A primer session forked by each worker** (`--resume <primer> --fork-session`). The worker's own request did read the memory from cache (39.5k read, 3.4k written), but a resumed session makes a second hidden request that writes the whole prefix again. Its billed cost was $0.149 against $0.132 cold. Dead on this harness.
- **`--exclude-dynamic-system-prompt-sections`**: no change. The environment is already a trailing block.
- **Shorter brief or smaller app instructions**: the app instructions sit in the system prompt, so they are cached reads. A worker's brief is under 1k tokens of the first write.
- **Output packs**: S1v3 showed output is about 1% of tokens and 11% of cost.

## Decision

**Team workers launch without the Claude Code tools their brief already forbids.** That is native subagents and workflows, other sessions, worktrees and cloud routines: `Agent,Task,Workflow,ListAgents,SendMessage,RemoteTrigger,CronDelete,CronList,EnterWorktree,ExitWorktree`. Read-only workers also lose `Edit,Write,NotebookEdit`. `TaskStop` stays: it also stops a worker's own background Bash.

Seven of these are tools Claude Code defers: `NotebookEdit`, `SendMessage`, `RemoteTrigger`, `CronDelete`, `CronList`, `EnterWorktree` and `ExitWorktree` (`CLAUDE_DEFERRED_TOOLS`).

- History can hold a ToolSearch reference to one, and removing its definition breaks later requests.
- So a new conversation denies them outright. A resumed launch keeps one only if the conversation held it or its history is unknown, which keeps all seven (`History::lists_native`).
- A kept tool the role denies is refused by a `PreToolUse` hook registered at `initialize`, in every permission mode (`claude_refusal_hooks`), because `can_use_tool` is not consulted in Full access, nor for edits in Accept edits.
- The tests in `providers.rs` use frames recorded from Claude Code 2.1.322 (the `initialize` hooks payload, the `hook_callback` and the deny reply; `the_refusal_hook_matches_frames_recorded_from_claude_code`). They were captured with `-p`, stream-json and `bypassPermissions` against a loopback model stub with a fake key, so no real API call was made.
- In that run the CLI accepted the hooks and refused `NotebookEdit` without running it. This covers one CLI version over loopback; it was not a subscription-login run.

The deny set is sticky, since adding a deferred tool changes the deferred-tool list. A conversation that started read-only keeps `NotebookEdit` denied after the lead flips the worker to writer, though `Edit` and `Write` come back; one that started as a writer keeps it defined and refused after turning read-only (`a_conversation_keeps_the_deny_set_it_started_with`). The deny set is computed once per launch and is part of the warm key, so a spare started with a different set is never adopted.

Apart from that sticky `NotebookEdit`, it changes nothing a worker is allowed to do. The brief says "Do not spawn native subagents", workers share one checkout, and read-only workers are told not to edit. It saves about 5.4k cached tokens on every step and about 0.6k of the first write. S2 measured billed cost at -1.8% (CI -4.4% to +1.0%, p = 0.30), so a cost saving is **not shown**: the removed tools were cache reads.

**Worker quality under the trim is not measured end to end.** S2 and S3 ran only localization and report tasks, so S3's writer units were those same tasks under a writer's launch, not real edits. GUI batch G2, which would test the app end to end, has 0 of 480 main runs, blocked by account quota ([gui-benchmark.md](gui-benchmark.md)). S2's quality figures are descriptive with no gate, and steps rose 6.9% there (also descriptive).

**The trim is opt-in (Settings → Agents → Trim worker tools, off by default; `worker-trim-on` marker, unreadable means off) because it has no measured token saving.** S2 found no billed-cost saving (−1.8%, CI −4.4% to +1.0%, spanning 0), steps rose 6.9% (CI +0.7% to +14.0%), LEAN workers made 92 Bash calls against BASE's 51, and writer quality is unmeasured (G2: 0 of 480 main runs). With `Skill` on (the default), what the trim buys is a smaller, stable cached prefix and a slightly faster start, not measured money. The bigger S3 saving applies only when the user turns `Skill` off and has a real skills library.

**`Skill` is on for workers by default.** Settings → Agents → Workers can use skills decides it (on; the `worker-skills-off` marker in app data turns it off).

- While it is off, team workers on Claude-family harnesses get `Skill` denied. Leads and ordinary tasks always keep `Skill`.
- The worker rules' "no Skill tool" sentence appears only while it is off and only for harnesses that really deny `Skill` (the Claude family). A user rule telling workers to use a skill stops working only then.
- None of 1,573 real worker transcripts on this machine called `Skill`. Its listing is about 8k cache-write tokens per worker with a real skills library.
- **`Skill`'s own effect on billed cost was not isolated.** Batch S3 compared round 18's launch with the launch before it on a copy of a real skills library. Its arms differ in three things: the `--disallowedTools` list (`Skill` added, `TaskStop` removed), the MCP server (BASE also lists the agent-made tools) and the instructions (BASE also has `REUSE`).
- That whole bundle came to about $0.037 less per worker run, a −20.5% ratio of means, 91% of it ($0.034) the first-step cache write ([worker-tokens-benchmark.md](worker-tokens-benchmark.md#batch-s3-results)). That write's drop is about 19% of BASE's $0.181 mean bill but only about 5% of its tokens (8,465 of 165k).
- There is no measured saving without such a library: batch S3b, which tested only the bundled skills, was voided by a usage limit after 32 of 336 runs and has no result, so the −20.5% applies only to a real skills library.
- Worker quality with or without `Skill` is unmeasured ([architect-workers.md](architect-workers.md#execution)).

- Code: `providers::claude_disallowed_tools`, the `CLAUDE_*_DENIED_TOOLS` constants and `CLAUDE_SKILL_TOOL`.
- `architect::worker_trim` sets `RunConfig::worker` (`WorkerTrim { read_only, skills, trim }`, `None` for a lead or plain task) when the turn is prepared. The launch fills `skills` from `architect::worker_skills_on` (the `worker-skills-off` marker in app data; an unreadable setting stays on) and `trim` from `architect::worker_trim_on`. With `trim` off workers get the plain tool set; read-only enforcement and the Skill switch apply either way.
- The trim and the deny set computed from it once per launch are part of the warm key (`warm::key_with`), so a changed trim starts cold.
- Tests: `providers::tests::workers_launch_without_the_tools_their_brief_forbids`, `warm::tests::a_worker_trim_change_starts_the_next_turn_cold`, `architect::tests::only_team_workers_get_a_tool_trim_and_read_only_ones_lose_edits`, and `tests/worker-skills-setting.spec.ts`.
- Leads, ordinary tasks, and Bash, Read, ToolSearch, WebFetch and WebSearch are unchanged.
- Managed team workers are not offered agent-made tools (`custom_tools`) or the `REUSE` instruction: no real transcript saved or ran one.

### PandaCode's own tools and instructions for workers

- `Role` in `src-tauri/src/app_instructions.rs` (`Task`, `Worker`, `ReadOnlyWorker`; `Role::wants()` → `HostTrim`) decides which PandaCode tool families a turn wants; `src-tauri/src/app_instructions/catalog.rs` (`History`, `Layers`) decides which it lists.
- It is recomputed on every turn from the worker's current assignment (`architect::worker_trim`), so a lead's follow-up that flips `readOnly` changes that turn's instructions and, on a new conversation, its catalog.
- On a harness without a system prompt, a resumed worker hears the short worker instructions again only when its role differs from the one they last went out for (`instructions_due`, recorded by `instructed_as` once a turn carrying them succeeds), or on a reminder turn.
- Leads and plain tasks keep every family.
- The trim (`RunConfig::worker`) and the tool catalog are both part of the warm key (`warm::key_with`), so a changed trim or catalog never adopts a process started with the old one. Today workers are not prewarmed at all (`warm_next` skips managed workers).

- **Every managed worker** does not want `pandacode_title` (workers never get a title run), the four `pandacode_schedule_*`/`list_schedules`/`cancel_schedule` tools, or agent-made tools.
- **Read-only workers** also do not want `pandacode_progress_snapshot`, `pandacode_design_write`/`design_resolve`, or `pandacode_track_files` and its instruction. They keep `pandacode_design_list`/`design_comments`, `pandacode_preview_file` and `pandacode_run_project`, which reviewers read with. Their tracker still runs on native write events. The tracking instruction follows the current role on every harness.
- **Only a new conversation should drop an unwanted family.**
  - The intended invariant for every tool trim is list-and-refuse: a resumed conversation should not lose a tool definition it may already hold (Claude can keep a ToolSearch `tool_reference` in resumed history, and removing the definition breaks later requests).
  - For PandaCode's own families, `Layers` keeps any unwanted family the conversation may hold listed, and every call to it is refused (`refuse_tools`).
  - Agent-made tool names (list, save, run) that a turn leaves out but a resumed conversation may hold stay listed with their real definitions and are refused the same way (`Layers::hold`).
  - A Plan turn, new or resumed, also lists whatever a Standard turn would, in the same position and refusing what Plan does not offer, so Plan-then-implement never changes the list (`plan_mode_lists_the_same_spec_bytes_in_the_same_order_as_standard`).
  - What a conversation may hold is remembered per task (`catalog::remember`, persisted in app data's `session-state.json` by `src-tauri/src/session_state.rs`): the tool names its turns listed on that conversation.
  - A task with no record (never seen, evicted past the 400-task cap, or a missing, corrupt, over-8 MiB or other-version file) has unknown history, and every family a layer can add is kept.
  - Codex sends dynamic tools only when its thread starts, so a family that can become wanted later in the same conversation (a read-only worker's writes, `flips`) is listed from a Codex thread's first turn and refused while read-only. A read-only Codex worker therefore saves none of the write definitions.
  - Tests: the 13 in `app_instructions/catalog.rs` (`a_resumed_worker_that_listed_titles_keeps_them_listed_and_refused`, `codex_lists_a_family_that_can_flip_from_its_threads_first_turn`, …).
- **Per-conversation state survives a restart.**
  - The role its instructions last went out for, how far its compactions were read and answered, the tool names it may hold and its Project tools note counter live in app data's `session-state.json`.
  - `session_state.rs` keeps one JSON file, rewritten atomically by temp file and rename when an entry changes. It holds at most 400 tasks, evicted by last use. Files over 8 MiB, corrupt, missing or of another version read as empty.
  - An empty record behaves as a fresh process did: unknown history keeps every family listed and the instructions and note go out again.
  - Tasks deleted by paths that do not clear their entry (bot resets) are pruned at startup (`session_state::retain` in `lib.rs`).
  - A resumed turn after a restart therefore lists and says what the same process would have, and sends the same except for lazily written marks (the note counter, compaction scan positions): one not yet saved at the restart resends its short text once (`a_restart_lists_exactly_what_the_same_process_would`). After a crash (no exit flush) a task keeps its older saved values rather than reading as unknown.
- **A read-only → writer flip rewrites the cache once.** `pandacode_track_files` is always loaded on Claude (never deferred) and the tracking instruction is part of the system prompt, so the first writer turn of a conversation that was read-only changes both the tools prefix and the system prompt; later turns read the new prefix from cache.
- **Native slash-command turns run bare** (`app_instructions::bare_command`): when the message is a slash command the harness runs itself (Claude Code and Codex pass everything after the name as `$ARGUMENTS`), it carries no tracking, Plan or Project tools note and no message-borne instructions. Nothing skipped is recorded as sent, so it rides the next ordinary turn; a harness without a system prompt that starts a new conversation with a command (Codex) owes that conversation's instructions to its next message (`slash_command_turns_carry_no_message_notes_and_owe_a_new_conversations_instructions`).
- **"Accepted" marks need a whole successful turn.**
  - The records that the instructions went out for a role (`instructed_as`), that a compaction was answered (`compaction_answered`) and that the Project tools note was sent (`NoteMark::accepted`) are written only when the whole turn succeeds and is not stopped (`result.is_ok() && !was_stopped` in `lib.rs`), not when the harness takes the launch.
  - "Accepted" means the turn ended cleanly. A stopped turn therefore resends that text once on the next turn.
  - A team brief's mark follows the same rule (`coordination::brief_accepted`, `brief_refused`).
  - Team rules and mailbox messages a turn delivered are likewise marked delivered only when the run ends cleanly, so a failed or stopped turn sees them again.
- **How `session-state.json` is written (intended behaviour).**
  - Hot-path counters and marks (the Project tools note counter, compaction scan positions and similar) are saved lazily, since losing one only resends a short text.
  - A widened tool listing is saved conservatively, before it matters, because forgetting a tool a conversation holds would break it.
  - If a listing save (`update_now`) fails, that task's listing is dropped in memory and on disk and reads as unknown history, which keeps every family listed; its other fields stay. A background write that finishes after the failure cannot bring back an older, narrower listing.
  - A failed lazy save is retried once, then waits for the next change or the exit flush (which also finishes a background write still in progress).
  - A listing recorded before the harness reported a conversation id applies only until a concrete id is seen; after that the record follows the real conversation.
- **Refused tools never ask on Claude.** On Claude-family harnesses a tool listed only to be refused is auto-allowed at Claude's own permission layer (`Protocol::refused_tools` in the `can_use_tool` handling in `providers.rs`, filled from `RunTools::refused`, the host's real refused set), so the handler refuses the call without an approval prompt. Codex and ACP harnesses have their own permission layers, which may still prompt for a refused tool before PandaCode's handler refuses it.
- **Change tracking instruction** is one text in every mode and harness (`turn_changes::instruction()`, 625 B, the constant's length): every edit batch, native tools included, begins a capture first.
  - It is part of the cached app instructions, so it never depends on the run's mode, allow rules or connection (a different prefix would make the harness rewrite the whole history's cache).
  - Only when native edits wait for approval does the turn's own message carry a 160 B note (`turn_changes::host::turn_note`, `EDITS_NOTE`; the test asserts < 200 B). It says native edits are tracked automatically from their `write_paths` events, so `begin`/`complete` are needed only around shell commands and scripts that edit files.
  - Edits wait for approval (`edits_wait_for_run`) for Claude, GLM and MiMo in Standard mode (`edits_wait_for_approval`), and for Claude only with no user allow rule for `Edit`/`Write`/`NotebookEdit` in the Claude settings files; a named connection, an unreadable config or a Claude Code managed policy file (`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, `/etc/claude-code/managed-settings.json` on Linux; present or unreadable) counts as allowing.
  - Switching modes therefore never rewrites the cache (`instruction_is_one_wording_and_only_waiting_turns_get_the_note`).
  - The agent-made tools sentence is one fixed text (`REUSE`), said whenever the run is offered the tools, in every mode. Whether the project has a tool rides only the per-message Project tools note (`none saved yet` when empty), and the tool specs are the same either way, so a first save or last removal changes neither the cached text nor the warm key.
  - The choice is persisted per task (`session-state.json`), so a restart keeps it; only a task with no record picks again.
  - Plan's caveat that tools cannot be saved or run is a 63 B line on the turn's message (`plan_tools_note`).
  - A native write whose baseline already equals its result still marks the turn partial ("Unreported or ambiguous edits were omitted") rather than showing no change (`turn_changes::host::tests::a_native_baseline_that_lost_the_race_is_flagged_never_silently_clean`).
- **Harnesses without a system prompt** get `RICH_QUESTIONS` and `GENERATIVE_UI` once per conversation.
  - On their every-8th reminder turn a self-contained one-line `RICH_REMINDER` (330 B, the constant's length) takes their place (`periodic_instructions`).
  - It names the blocks itself (```ui, ```chart, ```svg, static ```html, workspace images) instead of pointing back at the first message, so it stays true after a compaction the harness did not report: 5,744 → 4,178 B for a project task (`periodic reminder:` line of `cargo test --lib instruction -- --nocapture`).
  - A compaction the harness did report resends the full instructions on the next turn (`new_compaction`, recorded by `compaction_answered` once that turn succeeds; the record is persisted per task, so a restart does not resend them).
- **Compaction detection** reads the stored rows: a reported compaction is saved as a flat `tool_activity` row named `Compact context` (`COMPACT_CONTEXT_TOOL`), matched by the row's own name and output, never by text an agent printed. `app_instructions::new_compaction` is covered end to end, from a real Claude `compact_boundary` frame through storage (`a_claude_compact_boundary_stored_like_a_run_is_found_as_a_compaction`). `architect::coordination::compacted` runs the same match but is covered only through stored rows, not from a real `Protocol` frame.

Bytes per request (tool JSON as listed to the harness, compact; tokens at ~4 B/token are (est.)). The instruction texts are the constants' lengths. The per-family catalog sizes (title 623, track 696, schedules 4,130, progress 2,282) were measured once by serializing the listed JSON on 2026-11-10 and are not asserted by a test, so they are (est.):

| Managed read-only worker, new non-Codex conversation | Before | After | Saved |
|---|---:|---:|---:|
| Change-tracking instruction | 625 B | 0 | 625 B |
| Tool catalog, dropped families only: title 623, track 696, schedules 4,130 (when Settings lets agents schedule), progress 2,282 (local runs), design write/resolve (part of the four design tools' 1,095 B) | 7,731 B + design write/resolve, under 8,826 B (est.) | 0 | **full-schema bytes, upper bound** (see below) |

- The catalog row counts only the families a read-only worker drops; design list/comments, `preview_file` and `run_project` stay listed and are not in it.
- It is what a harness that receives full tool schemas on every request saves: under about 2.2k tokens (est.) per request.
- **For Claude-family workers it is an upper bound**: Claude Code defers MCP tool schemas and lists only their names until `ToolSearch` loads one, so the per-request gain there is a few dozen bytes per dropped tool name (est.), plus the 625 B instruction.
- The exception is `pandacode_track_files`: it is always loaded on Claude (`anthropic/alwaysLoad`, `listing` in `providers/mcp_host.rs`), never deferred, so its 696 B (est.) is a real saving there.
- A read-only worker whose conversation may hold the write families (it was a writer earlier in it, its history is unknown, or it runs on Codex) keeps them listed (calls refused), so its catalog saving is only the 4,753 B (est.) of title and schedules that every worker drops on a new conversation.

A writer worker saves 4,753 B (est.) of catalog (title and schedules; again an upper bound on Claude-family harnesses); its tracking instruction is unchanged. These bytes are cache reads after the first step, so the dollar effect is small (see [Batch S2 results](#batch-s2-results)); no paid benchmark was run for this change.

### Team briefs

Checked on the test fixtures in `src-tauri/src/architect/tests.rs` (no paid run; the figures are the `documented_brief_sizes` lines of `cargo test --lib architect::tests -- --nocapture`):

- **Launch briefs** list team notes in full, newest first, within 3,072 B (`LAUNCH_BUDGET`), then previews within 1,024 B (`PREVIEW_BUDGET`), then a count of the rest; `pandacode_team_notes` `get` returns a note's full text, and a note shown only as a preview arrives in full on the next turn unless fetched (`a_launch_brief_lists_full_notes_while_they_fit_then_previews`, `notes_shown_only_as_previews_arrive_in_full_next_turn_unless_fetched`). Measured: 9 notes that fit take 2,901 B; 21 notes take 3,916 B (9 full, 5 previews, 7 counted).
- **Team tool catalogs** are 4,246 B for the architect and 3,072 B for a worker (`team_turn_overhead_stays_within_budget`, which asserts ≤ 4,250 and ≤ 3,075 B). The `tokenSaver` parameter's schema is one line (`token_saver_schema`); its explanation is `saver::LEAD_SAVER_GUIDANCE` in `src-tauri/src/architect/saver.rs`, added to the lead's rules only while token saver packs are on in its thread (or its team guidance mentions them). The dispatch description itself carries none of it; that literal opens with `Start assignments` because the pinned `findLeadGuidance` finds it that way.
- **The lead's full coordination brief** goes out on a fresh conversation, at once after a compaction the harness reported (`a_fresh_or_compacted_context_gets_the_full_brief`), and when the rules change other than the roster (`briefing.rs`, `needs_full`); other turns get a one-line reminder and only unseen messages and notes.
- **A roster-only change** (a model paused, a worker added) is a `Team roster update` delta line instead of the full rules; the test asserts the delta turn is under half the size of the first full brief (`a_roster_change_is_a_delta_line_not_the_full_rules`). Measured: 1,707 B of full rules (2,166 B launch brief) → 549 B delta. The roster is the team's usable model profiles and the routing note that counts them (so a model paused or allowed again by model health changes it); dispatching a worker does not.
- **The periodic refresh** (every 8th turn) resends the rules but not the messages and notes the agent already saw, and adds a compact identity block (the agent's team ID, the never-poll rule, its saved checkpoint and the note keys) so a harness that compacted silently gets its identity back.
  - The block is 457 B (`periodic refresh identity block:` line of `a_periodic_refresh_resends_rules_but_not_messages_or_notes`, asserted < 700 B).
  - The net saving is the bytes of already-seen messages and notes minus those 457 B, so it depends on the mailbox.
  - On the fixture the full brief is 2,346 B, the rules alone 1,610 B, and the refresh with the identity block 2,069 B, a net saving of 277 B; with an empty mailbox and no notes the refresh costs the block instead of saving anything.

## Turn speed: cached instructions and warm spares

- **App instructions** (`app_instructions()` in `src-tauri/src/app_instructions.rs`, assembling sidebar titles, `pandacode-run.sh`, change tracking and `LOOK`; `LOOK` and the other instruction constants stay in `src-tauri/src/lib.rs`, where the pinned benchmark scripts read them) go to Claude-family harnesses (Claude, GLM, MiMo), Pi and Oh My Pi once as `--append-system-prompt` (`takes_system_instructions`), which caches with the prefix; other harnesses get them in the message on a new conversation and every 8th turn. Only a one-line current-title note rides each message.
- **Warm spares** (`providers/warm.rs`): after a successful Claude turn the next turn's process starts in the background (2 ordinary spares, 10 idle minutes; managed workers and cloud runs get none). A follow-up adopts one only when model, mode, effort, folder, resume ID, instructions, tool catalog and worker trim all match (`warm::key_with`; the MCP server is rebound to the new turn at the same address), so it skips the CLI's startup; anything else starts cold. Launch numbers come from one app-wide counter (`NEXT_LAUNCH`), `warm::discard` also forgets the task's launch number, and evicted, expired or refused spares are killed outside the pool lock.
- **Maintenance turns** (`/compact`, `/status`, `/context`, `/usage`, `/cost`, `/mcp`, `/tasks`, `/help`; `Resolution::maintenance`) keep the bare command as their message but carry the cached instructions, which are part of the warm key, so they adopt the task's spare instead of killing it (`a_maintenance_turn_matches_the_good_spare_and_starts_no_empty_one`). They start no spare of their own (`lead_spare::starts_spare`), so the next real turn after one starts cold once: a spare started after `/compact` would hold the pre-compaction conversation. A compaction stays due across a maintenance turn, and the next real turn answers it.
- **Lead spares** (the pool, its constants and the renewal loop are in `providers/warm.rs`; `src-tauri/src/lead_spare.rs` decides whether to keep and renew):
  - A team lead whose turn ends with live workers keeps its spare in a separate pool (`LEAD_LIMIT` 2) that ordinary tasks never evict.
  - On expiry it is restarted at most `MAX_RENEWALS` (2) times; the check is asked once per expiry and holds only while every live worker still runs and none waits on the user, and never once the lead's wake has launched (a "no" ends the chain).
  - A renewal re-reads the settings read at spawn (login, environment, telemetry, named connection), so a stale one is not restarted.
  - A brief's roster delta is recorded as seen only after its run ends cleanly (`coordination::brief_accepted`).
  - `stop_session` and the team's Pause or Stop (`architect_control`) drop it (`warm::discard`), and a lead turn ending while its team is paused, stopped or unreadable keeps no spare (`lead_spare::pool` → `Drop`).
  - A team that ended by itself (completed, ready, failed) gives its lead an ordinary spare with no renewals.
  - Tests: `cargo test --lib lead_spare` and `cargo test --lib warm`.
  - Every lead spare's adoption is logged to stderr so the wake speed-up can be measured: `Team lead's warm Claude agent adopted.` or `Team lead's warm Claude agent not used (<reason>); starting cold.`, where the reason is `its process exited`, `it expired`, `it was evicted by a newer team's spare`, `it was discarded` or `changed: <warm-key fields>` (`lead_note` in `providers/warm.rs`; never any contents); an ordinary spare's miss logs `Warm Claude agent not used (<reason>); starting cold.`.
  - Each of those lead lines ends with running totals since launch, `Lead spares since launch: <n> adopted, <m> not used.` (in-memory counters in the pool, `lead_decision` in `providers/warm.rs`; reset on restart, never saved or sent anywhere). To read them, take the last such line from the app's stderr (`pandacode serve` prints it to the terminal; the desktop app's stderr when started from a terminal); the per-line reasons above say why each miss started cold. The "not renewed" line at an expiry is not counted: the wake that follows counts it as `it expired`. How often lead spares are adopted in real use has not been measured yet.
  - A changed reasoning effort is a warm-key field, so it discards the lead's spare (`changed: effort`) and the next wake starts cold.
- **What a spare costs and saves.**
  - Each spare holds an idle CLI process, at most 4 in all: about 178 MB RSS in one measurement and 208 MB in another, both on a minimal config on one machine, so a config with plugins or MCP servers may differ.
  - Claude Code runs the user's `SessionStart` hooks when the process starts, before any message arrives (checked on 2.1.322 with no prompt sent).
  - A renewal chain can therefore start up to three processes, and run those hooks three times, for one wake (`1 + MAX_RENEWALS`), and hook context can be up to 10 minutes old when the spare is adopted.
  - The saving is the CLI's startup, about 1.4 s.
  - With an API key the 5-minute message cache has likely expired before many review wakes, so the spare does not save the history's cache cost; PandaCode does not set `ENABLE_PROMPT_CACHING_1H`.

## Token saver packs: recommendation

S1v3 found no output or cost saving from the lead's picks (output -1%, CI -5% to +4%). Input and cache rose by 6%, because the block itself is written into the first step. Localization recall did not pass its gate. Only edits showed an output drop (-11%, not significant). An omitted `tokenSaver` is now `"none"`, not the lead's own style, and the guidance tells the lead to leave it unless the user asks; lean-code+quiet-tools for edits is called optional and unproven ([token-saver.md](token-saver.md)).

<!-- prereg:S2 -->
### Pre-registration: batch S2

Written on 2026-11-07, after one smoke (`rep-explain-queue`, seed 99, both arms, $0.42, runs in `runs/smoke-S2`, never analysed with S2) and before any S2 run.

**Question.** For read-only team workers, does the worker tool trim lower billed cost, with localization and report quality unchanged?

**Arms.** Both use the S1v3 worker setup: Claude Code 2.1.317, worker model `sonnet` pinned to `claude-sonnet-5-5`, the `after` harness flags with the explore snapshot `bin-f`, `LOOK` appended, and the message `<report sentence>\n\n<task prompt>` with no saver block. They differ only in one flag. Both lists are read from `providers.rs` at run time, and their sha256 is pinned in `batch.json`.
- `BASE`: `--disallowedTools=ScheduleWakeup,Monitor,CronCreate`, the app's launch for every task before this change.
- `LEAN`: `--disallowedTools=` the session-bound, worker and read-only lists, which is `claude_disallowed_tools(Some(true))`.

**Tasks** (`scripts/agent-bench/tasks-s2.json`): S1's 20 localization tasks and 8 report tasks from `tasks-saver.json`, graded as in S1v3. No edit tasks, because LEAN is the read-only trim.

**Seeds.** 1, 2 and 3 for each arm: 168 runs. The job order and the arm order come from the batch seed in `batch.json`.

**Primary.** Billed cost per run, `BASE` → `LEAN`. We use per-task means over seeds, a two-sided Wilcoxon signed-rank test on the per-task differences, and a 95% bootstrap CI of the mean per-task relative change. Cost is read as lower only if p < 0.05 and the CI excludes 0.

**Secondary,** Holm-adjusted together:
- first-step cache-write tokens;
- input, cache-read and cache-write tokens.

Output tokens, steps and wall time are descriptive.

**Quality,** descriptive with no gate: localization recall and precision, and report rubric recall. Each is given as the mean per-task difference with a 95% bootstrap CI.

**Exclusions.** We exclude only runs whose `init.model` is not the pinned model. A run that errors or times out keeps its tokens and its grade.

**Expectation, written down before running:** a 2–4% cost drop. With 28 tasks it may not reach significance.

**Cost.** About $27 at $0.16 a run. The user approved unlimited spend.

**Commands.**

```sh
node scripts/agent-bench/s2.mjs --register        # appends this section's sha256 to results/preregistrations.jsonl
node scripts/agent-bench/s2.mjs --batch S2 --concurrency 4
node scripts/agent-bench/s2.mjs --analyze --summary scripts/agent-bench/results/s2-S2.json --csv scripts/agent-bench/results/runs/s2-S2.csv
```
<!-- /prereg:S2 -->

## Batch S2 results

Round 18 corrections to S2 and batch S3 (the worker launch with a real skills library): [worker-tokens-benchmark.md](worker-tokens-benchmark.md).

Clarification: the pre-registration above is hash-pinned and keeps the signature of its day, `claude_disallowed_tools(Some(true))`. The function now takes `(worker: Option<WorkerTrim>, history: &History)` (`providers.rs`): the conversation's remembered history, not a flag, decides which deferred tools stay listed. LEAN's list was the read-only trim either way.

S2 ran in full on 2026-11-07, as registered: 168 runs, 28 tasks × 3 seeds × 2 arms, $26.72. Every run resolved to `claude-sonnet-5-5`, so none was excluded, and none errored or timed out. BASE runs listed 21 tools and LEAN runs 8. Summary: `scripts/agent-bench/results/s2-S2.json`. Per run: `results/runs/s2-S2.csv`. Raw runs: `~/Library/Caches/pandacode-bench/s2/runs/S2`.

| Metric (per run, BASE → LEAN) | BASE | LEAN | Mean per-task change | 95% CI | p |
|---|---:|---:|---:|---:|---:|
| **Billed cost** (primary) | $0.1572 | $0.1559 | -1.8% | -4.4% to +1.0% | 0.30 |
| First-step cache write (secondary) | 25,858 | 25,239 | -4.0% | -5.3% to -2.9% | < 0.001 (Holm) |
| Input + cache tokens (secondary) | 154,386 | 147,033 | -9.0% | -15.8% to -1.3% | 0.057 (Holm) |
| Output tokens | 1,617 | 1,635 | +1.0% | -3.7% to +5.9% | 0.90 |
| Steps | 3.74 | 3.99 | +6.9% | +0.7% to +14.0% | 0.09 |
| Wall time | 17.7 s | 18.0 s | +2.1% | -2.6% to +6.9% | 0.51 |

Steps and wall time are descriptive. Their p values are reported but not tested.

| Quality (descriptive) | Tasks | BASE | LEAN | Difference | 95% CI |
|---|---:|---:|---:|---:|---:|
| Localization recall | 20 | 0.782 | 0.798 | +0.015 | -0.066 to +0.097 |
| Localization precision | 20 | 0.547 | 0.558 | +0.011 | -0.029 to +0.055 |
| Report rubric recall | 8 | 0.925 | 0.912 | -0.013 | -0.089 to +0.057 |

- **Billed cost: not shown to be lower.** -1.8%, CI -4.4% to +1.0%, p = 0.30. The expectation registered before the run (2–4%) sits mostly inside the CI, but S2 cannot tell it from no effect.
- **First-step cache write: lower,** by 4.0% (about 620 tokens), CI -5.3% to -2.9%, Holm p < 0.001. This is the tool definitions and listings that are no longer written.
- **Input and cache tokens: not shown to be lower** under the registered rule. The change is -9.0%, and the CI excludes 0 (-15.8% to -1.3%), but Holm p = 0.057.
- **Steps rose 6.9% (descriptive).** LEAN workers made 92 Bash calls (83 searches) against BASE's 51 (42), in 43 runs against 26, and 183 explore calls against 194. *Corrected in deviation S2-1: the first version said 39 Bash searches against 23, with 68 explore calls in each arm.* Neither arm ever called the removed tools. The extra steps take back part of the per-step saving.
- **Quality:** recall, precision and rubric recall moved by at most 0.015, and every CI spans 0. No quality gate was registered, so this is descriptive only.

So the trim makes each request lighter: about 5.4k fewer cached tokens per step, and 4% less first-step write. On these read-only Sonnet tasks it did not make a measurable dent in billed cost, because the removed tools were cache reads at $0.10/M. The money is in the memory files and the skill listing (see [Decision](#decision)). The memory is the user's. The skill listing is **not** left out by default: `Skill` is on for workers (see [Decision](#decision)), and it is dropped only when the user turns Settings → Agents → Workers can use skills off. Batch S3's −20.5% (a bundle of three changes, not `Skill` alone) is what turning it off saved with a real skills library, so by default that saving does not apply; batch S3b, the same test without one, is void and has no result ([worker-tokens-benchmark.md](worker-tokens-benchmark.md)).
