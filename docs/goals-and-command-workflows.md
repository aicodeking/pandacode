# Goals and harness command workflows

PandaCode uses the installed harness's protocol and native command registry. Public Codex operations have task-scoped controls; commands that belong to a terminal interface open that real harness in the embedded terminal. Terminal commands are inserted only when the user presses the insert button and are never passed as model prompts. The user submits them in the visible terminal, after authentication/trust screens have finished.

## Goals

`/goal` opens a goal editor with an objective and optional token budget. The task menu exposes the same control while a task is running. The retained goal banner shows provider-reported state, token usage, and elapsed work time. Pause, resume, edit, and clear use `thread/goal/*` APIs.

Codex itself schedules initial and subsequent turns. PandaCode keeps one connection alive while the goal is active and streams each turn through the existing transcript path. It does not inject continuation prompts or treat a completed turn as a completed goal. Active, blocked, paused, and limited goals remain in progress on the board; only completed goals can advance to review automatically.

An explicit stop pauses the goal before interrupting the turn. Interrupted app sessions recover with a paused goal, allowing the user to resume deliberately. Before loading an existing Codex thread, the adapter reads its goal and pauses any active goal before continuing; merely inspecting, pausing, or clearing a saved goal does not load it and cannot accidentally start work. Goal state is validated against the saved provider thread ID and persisted separately from transcript text.

Goals share the four-agent concurrency limit. The adapter bounds outstanding control requests, response sizes, and acknowledgment times. An idle continuation watchdog surfaces a stalled harness and pauses the goal. There is no app-level inference polling loop.

## Command controls

- `/usage`: account limits, reset times, and available usage history.
- `/goal`: persistent objectives and optional budgets.
- `/plan`: actual Codex collaboration mode; independent of approval policy.
- `/fast`: the task's speed tier, from the tiers the selected model's installed Codex catalog lists. `/fast` alone opens a menu of Default and those tiers, with the catalog's names and descriptions. `/fast <tier>` picks a tier by its key, which is the catalog name in lower case with spaces and symbols as `-` (so a tier named "Turbo Max" is `turbo-max`). `/fast on` picks the tier named Fast, and `/fast off` (or `/fast default`) goes back to the model's standard speed. A tier the model does not offer is refused with a note. The choice is saved with the task and kept across turns; after a model change, a tier the new model lacks falls back to its standard speed.
- `/personality`, `/experimental`, `/memories`: supported Codex preferences, with only allowed fields exposed.
- `/import`: a preview of detected agent setup; imports only explicitly selected, unchanged candidates.
- `/hooks`, `/plugins`: sanitized installed inventories. Native hook commands and credentials do not enter the renderer.
- `/resume`: existing Codex conversations in the current checkout; selected history is imported into the task view.
- `/fork`, `/side`, `/btw`: a separate task with copied context under the same project.
- `/ps`, `/stop`, `/clean`: inspect and stop individual background commands while their Codex process is alive.
- `/archive`, `/rename`, `/export`, `/worktree`, `/mention`, `/cd`: actual conversation or workspace controls.
- `/console`: the selected native harness's terminal interface. Terminal-specific commands, including guardian retry and deletion, use its own workflow and confirmations.

Only platform-inapplicable and internal diagnostic commands remain unavailable. Unknown command names fail explicitly. Claude and Kimi headless commands retain their provider dispatcher, with terminal-specific commands routed to their own consoles. Native authentication and integration availability remain prerequisites.

## Storage and process boundaries

Schema version 10 adds nullable goal snapshots and per-task Codex settings, preserving existing tasks, messages, worktrees, and theme preferences. Goal updates use the same retained UI elements rather than replacing the composer for each event. Settings merge individual fields to avoid lost updates. Running tasks and open harness consoles cannot concurrently own the same provider conversation.

Control requests derive the checkout and provider thread from saved task state. The frontend cannot submit arbitrary JSON-RPC methods, remote goal IDs, configuration paths, or import descriptors. Imports expire and are rediscovered before being applied. Native processes are bounded and reaped; no persistent server is introduced for idle tasks.

## Protocol references

Verified against installed Codex 0.154.0 schemas and its version-matched source:

- [App-server protocol](https://learn.chatgpt.com/docs/app-server)
- [Native goal runtime](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/ext/goal/src/runtime.rs)
- [Native goal lifecycle](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/ext/goal/src/extension.rs)
- [Goal API processor](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server/src/request_processors/thread_goal_processor.rs)

Tests use protocol fixtures and disposable browser contexts, without submitting paid model prompts or changing personal harness authentication/configuration.

Console permissions are displayed and controlled by the native harness. Codex
and Claude console launches receive explicit approval-mode arguments. Kimi's
Standard console retains its saved native permissions because its installed CLI
does not expose a flag to reset that state; the console banner identifies this.
Terminal-only output remains in the console/native history. Imported Codex
conversations load bounded text history into PandaCode; Claude/Kimi terminal
history is not synthesized into app comments.
