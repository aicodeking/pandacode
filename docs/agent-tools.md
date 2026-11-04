# Agent tools and integrations

PandaCode launches the installed Codex CLI through its app-server. Codex supplies
shell commands, file editing, image inspection, search, subagents, skills and
configured MCP integrations according to its version, configuration and policy.
PandaCode does not replace those tools with simulated implementations or enable
features the user's configuration has disabled.

## App tools

New Codex tasks register `pandacode_*` dynamic functions: project/task discovery,
task history and subagent activity, creating/starting/following up/renaming/
archiving tasks, board stages, worktrees, showing tasks/files/terminals, local
ports, browser navigation/reading/clicking/typing/screenshots, and project
moodboard discovery/metadata/image reading. See [Moodboards](moodboards.md).

Task operations remain within the current project. File previews use the task's
checkout and existing native path validation. Creating a worktree creates a task
under its original project. Starting another agent uses the same admission and
concurrency limits as the UI. Starting/following up on the current running task
is rejected. Use Codex's shell tool for command execution and its image tool to
inspect the local PNG returned by `pandacode_capture_browser`.

A string argument is held to its field's `maxLength` (8 KiB with none), counted in
characters: messages and task descriptions take up to the 16 MiB message limit.
`pandacode_read_task` reads a truncated message to its end with `messageId` and
`offset`, or the description with `offset` alone. `pandacode_list_subagents` does
the same for one subagent with `agentId`, `part` (`response`, `prompt` or `tools`)
and `offset`. A steer that `pandacode_steer_task` could not deliver is an error saying
`Not delivered: <reason>`, and nothing is queued: use `pandacode_queue_message`.

`pandacode_code_search` searches the task's checkout through the local
third-party `codedb` CLI when it is installed and on the app's PATH: a text
query by default, or symbol search with `symbols: true`. It is read-only and
runs as one bounded process per query (64 KiB of output, a 30-second deadline)
with `CODEDB_NO_TELEMETRY=1`; there is no daemon or resident index service, and
nothing is written inside the project (codedb keeps its own index data in its
home directory). Results are untrusted data. When codedb is absent the tool says so,
and agents keep their harness's own search tools. The tool runs without an
approval prompt, like the other read-only app tools.

Host callbacks are outside Codex's shell sandbox, so PandaCode enforces its own
approval boundary: mutations and browser/UI access request approval in Standard
and Auto modes, are unavailable in Plan mode, and run without a prompt only when
the user selected Full access. Browser access requires the calling task to be
visible; background tasks cannot hijack another task's browser. The browser
interface accepts a finite action and data, never agent-provided JavaScript or
generic native IPC. Remote page text is untrusted content. Remote webviews have
no application IPC access.

The installed app-server persists dynamic tools with newly created threads.
Its `thread/resume` API cannot add them to a conversation created without them.
Older tasks retain their original coding/MCP tools; start a new Codex task to use
newly added PandaCode app tools. Claude, GLM, Kimi, OpenCode, and Antigravity receive
these host tools through the authenticated, run-local MCP bridge where the
provider supports HTTP MCP. Codex uses its dynamic tool interface. Provider-owned
tools and integrations continue through their own protocols and configuration.

## Integrations and questions

Settings → Tools & integrations inspects Codex's MCP server/tool inventory,
project skills, and installed apps. Discovery is on demand, bounded, and does
not send a model prompt, create a thread, execute tools, change configuration,
or log into services. Codex may initialize configured servers during discovery.
Unknown, disabled and unauthenticated states are shown distinctly. The inventory
does not claim that all built-in tools or desktop services are enumerable.

Configure MCP servers with Codex CLI, following the linked official guide. The
next task run inherits the updated configuration. PandaCode now handles Codex's
structured questions and supported MCP form/URL elicitations. Requests are
isolated by run and task, drafts survive streaming, and Stop/resolution clears
them. Secret inputs use password fields and are not saved in conversation
history. Unsupported form constraints return an explicit protocol error instead
of silently accepting incomplete answers. URL authorization always requires a
separate explicit open and confirmation action.

Callbacks run asynchronously (up to 64 executing at once per run, with no cap on
MCP connections), with bounded arguments/results, timeouts and cancellation. A slow callback
cannot block provider stdout. Integration discovery is a short-lived process,
limited to one at a time, and cleans up children on completion/cancellation.

## Services that are not portable

This bridge does not reuse the Codex desktop app's private account, usage-reset,
automation, voice, CUA or hosted image-generation backends. Those require their
own supported integrations and credentials. No desktop session tokens or raw
provider configuration are copied or sent to the frontend.

Protocol verified against installed Codex CLI 0.154.0's generated experimental
schemas and the official [app-server documentation](https://learn.chatgpt.com/docs/app-server)
and [MCP guide](https://developers.openai.com/codex/mcp/).
