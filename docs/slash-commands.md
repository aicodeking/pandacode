# Slash commands

Type `/` at the beginning of a message in either Conversation or the Board task
panel. The menu shows names, descriptions, argument hints, and the selected
harness's logo. Type to filter; use Up/Down to navigate and Tab or Enter to insert.
Selection never starts a run. Add arguments and send the message separately.
Selecting **/skills** opens a searchable picker of the current agent's enabled
skills. Choose one to insert its command in your draft, keeping the text and
attachments you already added, then send when ready. Sending `/skills` opens the
same picker. **Manage skills…** opens Settings → Skills & rules if you need to
import or enable a skill; Refresh reloads the agent's available skills.
Escape dismisses the menu. The Refresh button explicitly reloads discovery.
Local and cached commands appear immediately and remain selectable while the
harness starts. A slow-start message explains the wait; a stalled request offers
Retry without clearing the available commands.

## Synchronization and execution

The saved task's harness and checkout determine its catalog, including worktrees.
PandaCode asks each installed harness for its metadata instead of copying its
configuration, command files, plugin code, authentication, or tokens. Changes to
provider-owned skills/custom commands become available through refresh or runtime
catalog notifications. This is discovery from each harness, not conversion of a
Claude command into a Codex or Kimi command.

| Harness | Discovery | Execution |
| --- | --- | --- |
| OpenAI Compatible | Enabled library skills at user/project scope, refreshed locally without a CLI | `/name` or `/skills:name` binds the selected library skill; app controls use the existing PandaCode handlers. |
| Claude Code | Initialize response, `system/init`, and full `system/commands_changed` replacements; names, aliases, descriptions, and argument hints | Advertised headless commands use Claude's native user-message dispatcher, including skill/custom-command expansion. Local command output is displayed in the conversation. |
| Codex | App-server `skills/list` with `forceReload`, and `skills/changed` invalidation | Skills bind the exact discovered name/path through typed `skill` input. `/compact` calls `thread/compact/start`; `/review [instructions]` calls `review/start`, reviewing uncommitted changes by default. |
| Kimi Code | ACP initialization and session-scoped `available_commands_update` | Advertised commands use the ACP slash dispatcher in `session/prompt`, including provider-discovered skills. |

Codex does not expose a general slash-command enumeration/execution API. Its
built-in command descriptions are a PandaCode compatibility catalog checked
against Codex 0.154.0; installed skill metadata is dynamic. Skill names colliding
with built-ins use `/skills:name`. Duplicate names are qualified by plugin/scope,
with a stable short identifier only when those still collide. Invocation retains
the original name and path; paths are not displayed in the dropdown.

Known app controls such as `/new`, `/model`, `/permissions`, `/settings`, `/theme`,
`/diff`, `/resume`, `/rename <title>`, `/copy`, and `/pwd` are marked **PandaCode**.
They open or operate existing controls without adding a model turn or consuming
attachments. `/model` and `/permissions` open the respective pickers; they do not
accept inline configuration arguments.

## Compatibility limits

- Terminal-specific commands open the actual installed harness in the embedded
  console, with a button to insert the selected command after the TUI is ready.
  They are never converted into model prompts. Internal diagnostics and commands
  requiring another operating system remain disabled with a precise reason.
- Goals, usage, import, fork, preferences, and other public Codex operations now
  have native handlers. See [Goals and command workflows](goals-and-command-workflows.md).
  Deprecated `$CODEX_HOME/prompts` expansion is not implemented; use current skills.
- Context/status commands retain the task's prior board stage after completion,
  interruption, or failure. They do not mark development work ready for review.
  A new Codex task must have a provider conversation before `/compact` can run.
- Commands that cannot consume attachments reject them before submission. The
  installed Kimi 0.26.0 ACP discards image blocks in its slash dispatcher, so
  PandaCode rejects attachments for Kimi slash commands. Normal Kimi messages
  still support the existing image flow.
- Kimi 0.26.0 exposes the command catalog only after creating/loading a session
  and has no ephemeral-session option. A fresh discovery can leave an empty
  provider session. The process is stopped/reaped; existing sessions are not
  deleted. Runtime notifications and the catalog cache reduce new discovery.
- Discovery depends on installed CLI/account availability. Failed refreshes show
  a warning and retain a previously successful catalog when available.

## Performance and boundaries

Discovery runs on demand, with at most two concurrent catalog lookups, bounded
process lifetimes and output, a five-minute native cache, and sixteen idle
provider/checkout cache entries. Active discoveries retain their shared slots
until they finish; concurrent requests for the same checkout reuse one discovery.
No background polling, filesystem crawler, or
idle provider process is added. Active goals retain their own bounded connection until they settle. Runtime metadata replaces the matching
catalog; invalidation cannot restore an older in-flight result.

Only recognized metadata reaches the renderer. Command names and collections are
bounded. Typed skill paths stay native. Discovery submits no model prompt,
authentication request, or reverse tool call. Claude discovery disables hooks.
The provider may initialize its own configured integrations to enumerate them.

Actual sends resolve commands again in native code, then atomically check the
saved harness, checkout, and original message before saving/claiming the task.
Normal approval behavior still applies to work requested by a command.

The menu updates existing row nodes and retains textarea focus. Catalog updates
are separate from transcript streaming. Async lookups cannot dispatch a local
control or collect files from a task selected in the meantime.

## Sources checked

- [Claude Agent SDK slash commands](https://code.claude.com/docs/en/agent-sdk/slash-commands)
  and installed Claude Code 2.1.270 initialize/command-update schemas. This build
  omits `terminalOriented` from some metadata; a narrow compatibility set protects
  known terminal commands, supplemented by its explicit terminal list.
- [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server), installed
  0.154.0 JSON/TypeScript schemas, and the
  [versioned terminal command definitions](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/tui/src/slash_command.rs).
- [Kimi ACP reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp)
  and the installed Kimi Code 0.26.0 ACP dispatcher. The separately installed
  legacy Python Kimi CLI has different behavior and is not used as its source.
