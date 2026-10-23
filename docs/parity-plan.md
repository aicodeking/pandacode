# Feature parity plan

A triage of a long competitor feature list (October 2026) against PandaCode. Each group is marked:

- **Have**: PandaCode already does this, possibly in its own form.
- **Done**: built in a finished phase.
- **Now**: being built in the current phase.
- **Next**: worth doing, scheduled for a later phase.
- **Skip**: does not apply to PandaCode (no mobile app, no multi-client server, harnesses we do not ship).

## Phase 1 (done): durable queue and steering

| Item | Status | Notes |
| --- | --- | --- |
| Type while an agent works; messages queue instead of being blocked | Done | The composer stays enabled during a run. |
| Durable queues that survive restarts, in order | Done | Stored in SQLite (`queued_messages`), not in the webview. |
| Hold restarted queues for explicit resume | Done | After a launch, a non-empty queue waits for **Resume**. |
| Preserve queues through usage limits, errors and stops | Done | A run that fails, hits a limit or is stopped holds the queue instead of sending the next message. |
| Edit, reorder, remove and steer queued messages | Done | Rows above the composer. Edits stay pending until saved. |
| Steer a running agent | Done | Native on Claude Code, GLM and MiMo (stream input), Codex (`turn/steer`), Pi and Oh My Pi (their own steer), Muse Code (on the wire) and OpenCode (a second `session/prompt`); the other harnesses queue the message for the next turn. |
| Alternate send shortcut (steer instead of queue) | Done | ⌘↩ / Ctrl+↩ while a run is active. |
| Queue previews and attachment counts | Done | |
| Agents can inspect and edit queues | Done | `list_queue`, `queue_message`, `remove_queued`. |
| Mobile queue editing | Skip | No mobile client. |

## Phase 2 (in progress): status, limits and timeline

| Item | Status | Notes |
| --- | --- | --- |
| Distinct limited status, manual resume and resume at reset | Done | Claude `rate_limit_event` and Codex `usageLimitExceeded` set `sessions.limited_*` (schema 24). Amber sidebar ring, composer banner, scheduler that recovers overdue resumes after restart and runs recovery before queued follow-ups. Unknown reset times are shown as unknown. |
| Snooze until reset | Next | |
| Show provider/model changes, handoffs, forks and interruptions in the timeline | Next | Handoffs and forks exist; they need timeline events. |
| Derive sidebar status from runtime state (working, waiting, limited, failed) | Next | |
| Reconcile stale runs after restart and tell agents which background work died | Next | |
| Stop works during startup and reaches background work | Next | |

## Phase 3 (in progress): references and agent tools

| Item | Status | Notes |
| --- | --- | --- |
| Thread references by title search and sidebar drag and drop; chips open the source | Next | |
| Agents retrieve referenced or omitted history on demand | Next | Extends `pandacode_read_task`. |
| Agents queue, steer, interrupt, rename, pin and archive threads | Done | New tools: `search_tasks`, `list_queue`, `queue_message`, `remove_queued`, `steer_task`, `interrupt_task` (reports a stop request, not a confirmed stop), `pin_task`. All project-scoped. |
| Agents mark threads unread and snooze | Next | |
| Agents change their own provider, model and options | Next | |
| Search thread titles and content | Done | `search_tasks` for agents. |
| Search thread content in the app, page long history | Next | |

## Phase 4 (next): automations

| Item | Status | Notes |
| --- | --- | --- |
| Scheduled tasks: create, edit, pause, resume, run now, delete | Next | Local scheduler in the desktop app. |
| Time zones for fixed schedules, filters by project | Next | |
| Agents create and manage scheduled tasks | Next | |

## Already in PandaCode

| Area | Notes |
| --- | --- |
| Switch providers mid-thread with context handoff | `provider-handoff.ts`, harness and model switching after the first message. |
| Fork from a message, Codex native fork | `conversation_fork.rs`, `fork_codex_task`. |
| Delegate tasks across providers and models; child threads; wait for results | Architect and workers, `pandacode_delegate`, subagent panels. |
| Create, start, read, send to, rename and archive threads through agent tools | `pandacode_*` host tools. |
| Worktrees per thread, branch reuse, cleanup | `worktrees.ts`. |
| Link pull requests and issues | `github.ts`. |
| Import native sessions, deduplicate, keep titles | Conversation import (0.2.35). |
| Separate context occupancy from usage; account limits | Context meter, Agent usage. |

## Skip

Mobile clients and mobile-only behavior; Pi and Cursor SDK integrations; Devin; the ACP agent registry and checksum onboarding; OpenCode 2 server runtime; multi-client synchronization, client and server version negotiation, and the separate v2 database migration. These depend on harnesses or a client and server split that PandaCode does not have. They can be revisited if those harnesses are added.
