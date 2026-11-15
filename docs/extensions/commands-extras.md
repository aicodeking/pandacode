# Slash commands and the harness command center v1 (experimental)

## Decision

Before v1 the composer slash menu and the harness command center had no extension adapter: the command center only
carried the generic dialog band (`panda.dialog.command-center`), and every package slash command was refused by the
blanket `SLASH_UNSUPPORTED` reason in `src/extensions/provider-cli.ts`, `src-tauri/src/extensions/providers.rs` and
the preview. v1 adds, owned by `src/extensions/commands-core.ts` (registry `COMMANDS_REGISTRY`, package slash rules,
admission) and `src/extensions/commands-host.ts` (menu arrangement, package slash commands, command center actions,
captured actions):

- `contributes.slashCommands` (at most 32 per package), validated identically by `schema-v1.json`, the SDK types
  (`SlashCommandDefinition`), `src/extensions/contracts.ts` and `src-tauri/src/extensions/contracts.rs`:
  `id`, `name` (`/` plus 1–32 lowercase letters, digits or dashes, unique per package), `description` (1–160
  characters), exactly one of `command` (a contributed command) or `provider` (one of the package's own providers), and
  an optional argument schema `arguments: { hint?, required, maxLength }` (`maxLength` 1–2048). Without `arguments` the
  command takes none;
- `panda.commands.slash`: package slash commands in the slash menu, after PandaCode's and the harness's own entries,
  labelled with their package. Each is a catalog item owned by its package (`inspect`, `hide`, `show`);
- `panda.commands.slash.entries`: PandaCode's own slash entries (`/new` … `/console`, `/wake`). They reorder among
  their own places and hide from the menu; typing a hidden one still runs it. `/help` never hides;
- `panda.commands.harness.entries`: the harness commands that open the command center (`/goal`, `/usage`, `/hooks`,
  `/import`, `/plugins`, `/ps`). They reorder among their own places and hide from the menu; typing one still opens
  its panel;
- `panda.commands.harness.actions`: contributed actions at the start of the command center's footer, captured with
  `selection.kind = "harness-command"`, `ids = ["<harness>:<panel>"]` and the panel's own task and project;
- `panda.commands.protected`, inspect-only: the draft and caret, sending to the harness, resolving typed names,
  command center changes (import, stop, resume, fork, preferences, goal changes) and consoles;
- the `commandsPresentation` / `commandsAction` contract for captured actions.

The adapter touches the slash menu only when an enabled package declares a slash command or the user arranged its
entries, and the command center only when a package contributes to `panda.commands.harness.actions`; otherwise, and in
safe mode, the menu lists exactly what the host and the harness return and the command center has no extra markup.
Filtering, IME, Enter, Tab, Escape, the completion's text-only insertion and the harness's own catalog are unchanged.

Rejected alternatives: inserting a package command's output into the draft or sending it to the harness (packages
would write the user's message); package-rendered menus or panels (would copy completion, IME and the panels' own
actions); letting a package name shadow PandaCode's or the harness's command (the user's typed command would change
meaning); a new recipe (the selected `panda.composer` provider is reused as owner of captured actions).

## Package slash commands

A `command` entry is chosen like any entry: completion inserts its name. Sending the draft runs the package command
once through the existing command invocation (`invokeExtensionCommand`, surface `panda.commands.slash`) with the
captured window, project, task, revision, `selection.kind = "slash-command"` (`ids = [<task>]`) and
`slash: { command, provider, arguments }`, where `arguments` is only the text typed after the name, checked against the
declared schema. The draft is cleared after the command ran; nothing is inserted into it or sent to the harness. A
refusal (arguments, a disabled or faulted extension) leaves the draft and the caret as typed with a note above the
composer.

A `provider` entry is listed only for tasks on that provider, by the native catalog (`slash_commands.rs`
`package_catalog`, from `Packages::provider_slash_commands`): it resolves as typed (after its argument schema) and goes
through the provider's own send path, the same path as a prompt. PandaCode's controls (`/rename`, `/model`, …) keep
their names over a declaration. A package provider that advertises nothing keeps the stable refusal
`SLASH_UNSUPPORTED` ("this extension provider does not advertise this slash command"), now the only unsupported case.

Conflicts: a name PandaCode or the harness already lists, or that two packages declare, is shown unavailable with the
reason (`Conflict: …`) and never runs; sending it goes to the host's own resolution, which keeps its meaning.

## Captured actions

Captured actions are owned by the selected, unfaulted `panda.composer` provider (`toolbar-first`): the slash menu
belongs to the composer. A `commandsAction` carries the opaque window, mount, project, task, harness and revision of
the `commandsPresentation` it was built from, plus a control handle and its resource (a harness command panel). The
presentation says whether the slash menu is open, which command center panel is open and how many package slash
commands the menu offers; never the draft, typed names, panel contents or the harness's catalog. An edited draft,
another task or harness, an opened or closed panel or any redraw changes the revision: an older request is
`StaleContext`.

| Control | Effect |
| --- | --- |
| `harness-open` | Shows a fresh host choice ("Extension requested a harness command"); Continue runs the original `openCommandPanel` / `openGoal` for the same task. Escape declines. A harness entry the user hid is not acted on. |
| `harness-refresh` | The open command center's own Refresh. |
| `harness-close` | The open command center's own Done. |

`slash-send`, `slash-insert`, `slash-read-draft`, `harness-execute` and `console-open` are refused with
`PermissionDenied` before any other check. Other reasons: `Revoked` (safe mode, fault, disable, another owner's
identity), `WrongOwner`, `InvalidArguments`, `UnsupportedCapability` (hidden or disabled control, other contract
version), `Busy` (an open slash menu, another dialog, menu or host choice), `AlreadyApplied`.

## Recovery

Conflict, fault, disable, another selected provider and safe mode keep the draft and the caret; a command runs at most
once per send and a refused one runs nothing. Safe mode restores the built-in menu order and entries without deleting
the stored preferences. Installed WebView qualification is not claimed; evidence is the browser preview
(`tests/extensions-commands-extras-coverage.spec.ts`, Chromium and WebKit), the Node contract tests
(`tests/extensions-commands-extras.test.mjs`) and native contract, package and slash command tests.
