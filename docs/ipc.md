# Native IPC contract

All command args use camelCase. Types are in src/types.ts. All return Promises via invoke; errors reject with a string. All native data is real; browser preview explicitly uses fixture mode.

`Session.mode` accepts `ask`, `auto`, `plan`, and `full`. The native provider maps
these to its own approval settings; the UI uses harness-specific labels and
descriptions (see [approval modes](approvals.md)). The mode is saved per task.
New tasks and harness changes start in `ask`. Model/permission updates are rejected
while an agent is active, and a new turn explicitly reapplies the selected policy
when resuming an existing harness conversation.

Schema version 14 adds the internal `context_recovery` table, keyed by task with a
message-ID boundary. Required Codex tool-catalog resets queue recovery in the same
transaction as clearing the native session ID. A one-time migration queues tasks
with the exact legacy architect reset notice. Preparation advances the boundary
before recording the new user prompt; the queue survives retries/restarts and is
cleared only for the successfully delivered boundary after turn persistence.
There is no public IPC/type change. See [conversation continuity](providers.md#conversation-continuity).

`Session.worktreePath` is the task's absolute checkout path, or `null` for a task
in its project's main folder. `projectId` always identifies the original project.
Git, files and terminal commands accept `sessionId` to resolve that checkout;
omitting it uses the project folder. A mismatched task/project or missing worktree
rejects instead of falling back to a different checkout. Agent turns use the same
resolver. Worktree tasks cannot change their project, even before the first message.

`create_worktree` creates a branch from the source task's checkout and saves a new,
empty task in the same project. It inherits the harness/model, starts with `ask`
approval behavior, and has no provider resume ID. It does not add a project.
Schema version 4 adds the nullable checkout column. Version 5 folds recognized legacy
app-created worktree projects, including nested worktrees, into their registered main project in one transaction,
preserving task IDs, history, settings and files. An empty legacy worktree receives
an empty task. Custom or ambiguous folder layouts are left intact.

`fork_session_at_message` creates a separate task with the saved conversation
through the selected user or assistant message, inclusive, for every harness.
The message must belong to the source task. Synthetic streaming messages and
internal coordination/change rows cannot be selected. Copying uses the complete
stored prefix across all history pages, independent of display truncation, and
is atomic; it can snapshot a running source without stopping or changing it.
Successful forks emit `sessions-changed` with no data to refresh every window.
The fork retains the source project, harness, model, effort, approval mode and
Codex preferences. It shares the source's existing checkout, including any
uncommitted changes; it does not rewind files or create a Git branch. A missing
checkout rejects instead of silently switching to the main project folder.

The new task starts idle and unarchived, in progress, with fresh message IDs and
no provider resume ID, goal, context-usage snapshot, subagents or team execution
state. A team worker can fork into a standalone task. Its first normal message
uses the existing bounded [conversation recovery](providers.md#conversation-continuity)
handoff (up to 200 recent user/assistant/coordination messages and 64 KiB), so a
provider cannot resume later source context. The complete prefix remains saved
even when that handoff is shortened. Historical tool IDs are regenerated and
unfinished tool snapshots become interrupted history. Source checkout change
records, hidden internal/change rows and execution durations are not copied.
Copying a transcript makes no provider request; starting the new task follows
the ordinary execution path.

`get_message_content` reads the complete saved text of one user message or
assistant response on demand for copying, without the history page's display
truncation. It validates that the message belongs to the selected task and
rejects internal coordination prompts, including recognized legacy user rows.
It is read-only and makes no provider request.

`Session.lastResponseAt` is the Unix-millisecond timestamp of its latest saved
nonempty assistant response, or `null` before the first response. It is independent
of `updatedAt`: prompts, tool/status/error messages and metadata edits do not change
it. Schema version 2 backfills existing responses once in a transaction and updates
the timestamp with subsequent assistant message inserts. Session listing reads the
stored column without loading transcripts. During a live stream, the UI preserves
the latest observed response time until the native transcript is flushed.

`Session.lastPromptAt` separately records the Unix-millisecond timestamp of the
latest nonempty user prompt, or `null` when none exists. Schema version 19
backfills saved user prompts and keeps the value in session metadata, so listing
tasks does not load their transcripts. Internal coordination prompts do not count
as user activity. The sidebar uses the later of `lastPromptAt` and `lastResponseAt`
for its 24-hour Active grouping, sorting, and age label. Sending a prompt updates
the UI immediately while the native send is pending.

`Message.turnDurationMs` is a nullable, nonnegative duration on the user message
that initiated a turn. Schema version 6 adds `messages.turn_duration_ms`. Native
execution measures elapsed time with a monotonic clock, stores it on the exact
initiating row for success, failure or cancellation, and emits `done` afterward.
Repeated completion cannot overwrite the first measurement. Other message rows,
legacy history and startup-interrupted turns retain `null`; no elapsed time is
fabricated during migration or recovery. This adds no transcript rows or polling.

`Session.reasoningEffort` is a nullable, provider-defined effort ID. Schema version 7
stores it with the latest `Session.contextUsage` snapshot (`usedTokens`, nullable
`contextWindow`). `set_reasoning_effort` returns the updated task and rejects active
tasks. Null delegates to the harness's saved settings. Changing a model or harness
resets effort and usage; changing only the project preserves effort. Worktree tasks
inherit effort and begin with no usage snapshot.

Model metadata may expose `reasoningEfforts` (`id`, `name`, `description`),
`defaultReasoningEffort`, and `contextWindow`. Missing metadata does not imply zero
capacity or an invented set of supported efforts. An `agent-event` with `kind: "usage"`
and `data: {usedTokens, contextWindow}` replaces the latest context snapshot without
changing response recency or creating a transcript message. Counts are bounded to
one billion tokens; capacity, when supplied, must be positive. This is current
context information, not accumulated billing usage.

Schema version 8 adds `Session.taskStage` (`pending`, `in_progress`, `review`,
`completed`), `taskDescription`, and nullable Unix-millisecond `completedAt`.
`list_sessions` caps descriptions at 512 Unicode characters; `get_task` returns
full details. `start_task` sends the saved description, falling back to the title.
Both start commands atomically claim the task and enter In progress. Successful
turns enter Review; failures and explicit cancellation remain In progress.
Only `set_task_stage` can mark completion. Completed or archived tasks reject
new turns until reopened or restored, and active tasks reject details/stage edits.
Nothing archives tasks any more: at startup every archived task becomes an
unarchived, completed (Settled) one.

| Command | Args | Return |
|---|---|---|
| architect_get | {sessionId} | TeamSnapshot or null |
| architect_configure | {sessionId, config: TeamConfig or null, architect?: ModelSelection, profileId?: string} | TeamSnapshot or null; atomically remembers default; active parent turns queue a durable pendingSetup, applied after completion; existing assignments retain their selections |
| architect_profiles | none | TeamLibrary (default setup and named profiles) |
| architect_save_profile | {id?: string, name, setup: TeamSetup} | TeamLibrary; saves template without applying it |
| architect_delete_profile | {id} | TeamLibrary; applied setup and histories retained |
| architect_start | {sessionId, text, imageIds?} | void (starts or queues architect) |
| architect_control | {sessionId, action: "pause", "resume", or "stop"} | TeamSnapshot |
| architect_worker_messages | {sessionId, workerId, beforeId?} | MessagePage (parent-scoped worker history) |
| list_projects | {} | Project[] |
| add_project | {path} | Project |
| remove_project | {projectId} | void |
| list_sessions | {} | Session[] (metadata, maximum 500) |
| get_task | {sessionId} | Session (full task description) |
| create_board_task | {projectId, provider, model, mode, title, description} | Session |
| update_task_details | {sessionId, title, description} | Session |
| set_task_stage | {sessionId, stage: "pending" or "review" or "completed"} | Session |
| start_task | {sessionId} | void (returns after task spawned) |
| configure_window_appearance | {reducedTransparency: boolean, increasedContrast: boolean, darkMode?: boolean} | {platform: "macos" or "other", material: "liquidGlass", "vibrancy" or "solid"} |
| create_session | {projectId, provider, model, mode} | Session |
| fork_session_at_message | {sessionId, messageId: number} | Session (new standalone task, inclusive saved history) |
| configure_session | {sessionId, provider, model, projectId?} | Session |
| set_reasoning_effort | {sessionId, reasoningEffort: string or null} | Session |
| update_session | {sessionId, title?, archived?, model?, mode?} | void |
| get_messages | {sessionId, beforeId?: number} | {messages: Message[], hasOlder: boolean} (latest 100, chronological) |
| get_message_content | {sessionId, messageId: number} | string (complete saved user/assistant text) |
| send_message | {sessionId, text, imageIds?: string[]} | void (returns after task spawned) |
| stop_session | {sessionId} | void |
| respond_approval | {sessionId, requestId, approved} | void |
| list_providers | {} | Provider[] |
| list_slash_commands | {sessionId, force?: boolean} | {commands: SlashCommand[], warnings: string[]} |
| resolve_slash_command | {sessionId, text} | {action: string or null, arguments: string, acceptsAttachments: boolean} |
| list_provider_models | {provider} | ProviderModel[] (identity, supported effort choices, optional default effort/context window) |
| git_status | {projectId, sessionId?} | GitStatus |
| git_diff | {projectId, sessionId?, path?, staged?: boolean} | string (max 256 KiB) |
| git_stage | {projectId, sessionId?, paths: string[], staged: boolean} | void (true stage, false unstage) |
| git_commit | {projectId, sessionId?, message} | string |
| create_worktree | {sessionId, branch} | Session |
| list_files | {projectId, sessionId?, path?: string} | FileEntry[] (one folder, max 500) |
| search_files | {projectId, sessionId?, query: string, limit?: number} | FileEntry[] (project-relative filename matches; default 40, max 100) |
| read_file | {projectId, sessionId?, path} | string (max 128 KiB) |
| start_terminal | {projectId, sessionId?, cols, rows} | string (terminal ID) |
| write_terminal | {terminalId, data} | void |
| resize_terminal | {terminalId, cols, rows} | void |
| close_terminal | {terminalId} | void |
| get_metrics | {} | Metrics |
| list_local_servers | {} | {port, process, url}[] |
| browser_open | {url, bounds: {x,y,width,height}} | BrowserStatus |
| browser_bounds | {bounds: {x,y,width,height}, visible} | void |
| browser_action | {action: "back" or "forward" or "reload" or "stop"} | void |
| browser_pick | {enabled} | void |
| browser_capture | {} | BrowserScreenshot |
| browser_close | {} | void |

Browser commands are restricted to the trusted `main` webview. Events sent only
to that view are `browser-state` (URL/title/loading/navigation state) and
`browser-element` (bounded selected DOM context). BrowserStatus,
BrowserScreenshot, and BrowserElement are defined in src/types.ts. Screenshot
IDs resolve only inside the managed browser capture directory. See
[browser behavior and resource limits](browser.md).

Events: `agent-event`: AgentEvent; `terminal-event`: TerminalEvent. Text events are deltas. Tool events carry an activity label and an optional normalized `tool` snapshot. Approval includes an opaque requestId; respond exactly once. Done marks the end; error shows failure. Session carries the provider resume ID and is managed natively. Persist user+assistant+tool/error/status messages, not each token. Subscribe before send_message. Avoid dropping background thread events; refresh sessions on done.

Approval request IDs are scoped to their task and run. Native code rejects stale,
foreign, repeated, or stopped-run replies and keeps a task waiting while any other
approval remains outstanding. `approval_cancelled` removes only its matching
request; receiving it after completion cannot restart a UI stream. A run queues
its `done` event before releasing its execution slot for another start of that task.

`message_start` separates main assistant messages before their first nonempty text
delta. Its optional data contains a bounded `messageId` and `phase`; it creates no
history row. New tool calls also end the preceding text segment, while progress
and completion updates to existing tool IDs leave the current response intact.

Conversation and Board share the same live response buffer. Incoming text is
painted on the next frame and sanitized Markdown updates are coalesced at 32 ms,
reusing existing nodes and completed blocks. Background tasks keep receiving text
without mounting additional transcripts. At `done`, the final buffer stays visible
until saved messages replace it. A failed history load retains that text and offers
an explicit retry rather than leaving a blank response or silently discarding it.

Submission preparation is locked per task, so file reads or a pending start cannot
block another task. Background token, tool-output and status events update bounded
buffers without rebuilding navigation. Running, recency and approval changes share
one navigation frame. Hidden transcripts pause rich rendering and elapsed-time
updates, then catch up when shown.

`get_messages` returns at most 100 messages for the requested session, strictly
before `beforeId` when supplied. `hasOlder` reports whether that session has
messages before the returned page. Message IDs are global across sessions, so
their numeric values do not indicate whether a task has older history. The UI
offers earlier messages only when `hasOlder` is true and replaces the visible
page when paging, keeping transcript memory bounded.

`configure_window_appearance` updates only the calling window on the AppKit main
thread. macOS accessibility settings override the requested preferences. The
frontend serializes updates and exposes transparency only after a successful reply;
failures, other platforms and browser preview retain opaque surfaces. The native
material is reused until its type changes and released when its window closes.
`darkMode` updates window chrome and the material's Aqua/DarkAqua appearance;
omitting it selects the dark default. Theme changes reuse the material.

`AgentEvent.tool` contains `{id, name, status, input, output}`. Status is `running`,
`completed`, or `failed`; input and output are plain text. Each snapshot replaces
the previous snapshot with the same ID. Native code prefixes provider IDs with a
per-run UUID so subsequent turns cannot overwrite earlier calls. Raw IDs and names
are limited to 256 UTF-8 bytes, input to 4 KiB, and output to 8 KiB, with explicit
truncation notices. Opaque provider payloads are not sent through IPC.

Schema version 3 adds a nullable `messages.tool_id` and a unique index on
`(session_id, tool_id)`. Tool start, progress and result update one row, retaining
its original message ID and position. Its content is versioned JSON:
`{type: "tool_activity", version: 1, ...tool}`. Storage permits up to 96 KiB of
serialized JSON to accommodate escaping without truncating valid records. Legacy
tool strings remain readable; missing historical details are identified in the UI.
Unfinished tools are settled with an explanatory failure note when a turn ends or
an interrupted session is recovered at startup. Tool updates do not change a task's
last assistant response timestamp.

`AgentEvent` kind `subagent` carries a full bounded snapshot in `data`:
`{id, parentId, name, prompt, status, response, tools, startedAt, updatedAt}`.
Timestamps are Unix milliseconds; status is `running`, `waiting`, `completed`,
`failed`, or `stopped`. The run UUID scopes child and parent IDs, while nested
tool IDs also include the child ID. Snapshots replace by ID and never become
parent transcript messages. `list_subagents({sessionId})` returns up to 64
snapshots, combining current in-memory work with persisted history. The UI must
preserve events received after a history request started when merging its reply.

Schema version 9 stores child snapshots in a separate indexed `subagents` table,
independent of the parent message window. First sightings and status transitions
are saved immediately; intermediate text/tool snapshots checkpoint at most once
per second per child and flush when the parent turn ends. Stored history retains
the latest 64 children per task, preserving active children. A successful or
stopped parent settles children that never reported completion as `stopped`;
a failed parent marks them `failed`. Startup recovery settles leftover live
children as `stopped`, preserving their last saved work. Abrupt process loss can
lose updates since the latest checkpoint. Availability and detail depend on what
the installed provider protocol reports; the app does not infer unseen work.

`configure_session` rejects active turns. Providers must be `claude`, `codex`, or
`kimi`; model IDs may contain at most 200 UTF-8 bytes. An existing conversation can
change its model while retaining the same provider. A different provider is allowed
only when the task has no persisted messages and no provider resume ID; this check
includes history outside the visible message page. Switching provider resets the
permission mode to `ask`. The optional `projectId` must identify a registered project;
changing projects requires the same empty-history and absent-resume-ID conditions.
Omitting it preserves the current project. A project-only change preserves the task
ID, provider, model, permission mode, title, archive state, status, creation time and
last-response timestamp. The command returns the updated session. The check and update occur
under the same agent/store locks as turn startup, with an atomic database condition.

`list_provider_models` loads metadata on demand; `list_providers` does not perform
this lookup. Keep invocation `id` separate from display `name` and `description`.
Claude projects SDK initialization metadata and resolves release names from the
supplied model ID; Codex retains `model/list` display names; Kimi projects only model
fields from its configured CLI catalog. No prompt or inference is needed. See
[provider integration details](providers.md) for sources, bounds and cleanup.

The UI caches catalogs for five minutes and refreshes on the next request, without
polling. Failed requests are retried on reopening. Unknown providers, unavailable
CLIs and failed catalogs reject with a string; default/current and custom model IDs
remain usable. Account and organization restrictions still apply at execution.


## Slash command dispatch

`SlashCommand` contains `id`, leading-slash `name`, `description`, nullable
`argumentHint`, `kind` (`prompt`, `action`, or `unsupported`), `source`, and
nullable `reason`. Native invocation metadata, including discovered skill paths,
is never serialized. `list_slash_commands` resolves the saved task's provider and
checkout; the frontend does not supply discovery paths or arbitrary executables.

`resolve_slash_command` validates the current draft and identifies app controls.
It returns no expanded prompt or private skill binding. `send_message` resolves
again natively and rechecks the provider, checkout, and original text under the
execution claim lock. Bypassing the UI cannot send an unsupported/unknown command
as ordinary model text or call an app-control command through a model run.

A parent-session `agent-event` with `kind: "commands_changed"` invalidates the
composer's metadata cache without creating a transcript row or modifying run
status. Raw metadata stays native. Native catalog changes replace existing
entries and cannot be overwritten by stale in-flight discovery.

Maintenance commands such as compaction restore the previous board stage during
finalization. Normal task completion still moves development work to Review.

## Goals and command workflows

`task_goal(sessionId, request)` accepts a tagged `set` (objective, nullable
`tokenBudget`), `get`, `pause`, `resume`, or `clear` request. It derives the native
Codex ID from the saved task. Returned `GoalState` is the validated native goal:
`threadId`, `objective`, `status`, `tokenBudget`, `tokensUsed`, `timeUsedSeconds`,
`createdAt`, `updatedAt`. A missing/cleared goal is null. Get is observational and
never resumes a thread. Set/resume share the task execution limit and startup
admission checks; live controls use the existing provider connection.

`agent-event` adds `goal`, `goal_ready`, `goal_input`, `turn_start`, `turn_complete`,
and `task_settings`. Goal events carry authoritative state or null; `goal_ready`
acknowledges a startup operation only after persistence. `goal_input` records a
live goal edit as user input. Turn boundaries flush response segments and
namespace repeated tool IDs. `task_settings` persists normalized, acknowledged
Codex collaboration/service settings. None of these metadata events invents
assistant responses.

`codex_command(sessionId, request)` exposes only the typed usage, hooks,
preferences, selected imports, conversation inventory, and plugin operations.
`codex_jobs(sessionId, stopId?)` lists live background commands or stops one
verified process belonging to this running task. `set_task_preference` accepts
only Plan/Fast toggles; the selected model is resolved and Fast availability is
checked against its current native catalog.

`fork_codex_task(sessionId, remoteId?)` forks the saved Codex conversation or
adopts a verified conversation in this checkout. Adoption imports bounded history
and indicates truncation. `archive_codex_task` updates both native and local task
state. `export_task` returns at most 8 MiB of Markdown; `save_task_export` writes
the export to a selected absolute .md/.txt path.

`start_harness_terminal(sessionId, cols, rows)` derives the executable, checkout,
model, mode, and saved conversation natively. The UI never supplies an executable
or shell program. It starts the actual harness directly in a managed PTY. A task
cannot run in both an agent and a harness console. Terminal command text is
validated and inserted only after the user presses the visible button; Enter is
not sent automatically. Console-only interaction remains in the native console;
it is not presented as a synthetic assistant response.

## Saved turn changes

Schema 13 adds immutable `turn_changes` summary records and on-demand
`turn_change_files` patch bodies. Completion appends a message with `role: "changes"`,
empty content, and `turnChanges: {id, files, additions, deletions, truncated,
concurrent, attributed, error?}`. New captures set `attributed: true`; legacy
whole-checkout captures default to false and are not rendered as task changes.
Each file has `path`, optional `oldPath`, a status
(`added`, `modified`, `deleted`, `renamed`), nullable line counts, and
binary/truncation flags. The UI also accepts `turnChanges` on legacy user messages.

`agent-event` with `kind: "turn_changes"` contains
`data: {messageId, turnChanges}` after persistence and before the final `done`.
Native goal continuations emit a boundary for every completed turn. This event
does not mean the whole goal or team has finished. Transcript requests include
summary metadata in their existing bounded page; they never include patch bodies.

`turn_change_diff(sessionId, changeId, path)` verifies all three against saved
records and returns `{path, oldPath?, patch, binary, truncated, error?}`. It never
reads the current checkout. Removed historical bodies return an explicit retention
notice. Worker snapshots use the worker's session ID. See
[turn changes](turn-changes.md) for capture semantics and limits.

Task-scoped Run Script discovery, execution, and preview readiness commands are
documented in [Run and preview](run-project.md). Execution uses the existing
managed terminal event/lifecycle contract; it never interpolates shell commands.

## Voice dictation

`voice_state()` returns `{settings, models, recording, appleAvailable,
microphoneAvailable}`; `voice_save_settings(settings)` normalizes and saves
`voice.json`, returning the normalized settings. `voice_models()` lists the
catalog with install state; `voice_download_model({id})` streams one model in
the background, emitting `voice-download {id, status, progress, error?}`.
`voice_start()` refuses when voice is off, a recording is already running or
the required models are missing; `voice_stop()` finalizes and
`voice_cancel()` discards. Online modes add `voice_providers()` (the preset
registry), `voice_set_key({provider, key})` (secure store; empty key forgets),
`voice_keys()` (provider ids with saved keys) and
`voice_test_provider({provider})` (a silence probe through the real
endpoint). Events: `voice-partial {text}` replaces the live
text, `voice-result {text, engine, fallback}` settles the transcript,
`voice-error {message}`, `voice-level f32`. See [voice](voice.md).
