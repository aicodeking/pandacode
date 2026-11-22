# Agent tools and integrations

PandaCode launches installed coding-agent harnesses. Each harness supplies
shell commands, file editing, image inspection, search, subagents, skills and
configured MCP integrations according to its version, configuration and policy.
PandaCode does not replace those tools with simulated implementations or enable
features the user's configuration has disabled.

## App tools

Standalone tasks and team leads receive `pandacode_*` app tools: project/task
discovery,
task history and subagent activity, creating/starting/following up/renaming/
archiving tasks, board stages, worktrees, showing tasks/files/terminals, local
ports, browser navigation/reading/clicking/typing/screenshots, and project
moodboard discovery/metadata/image reading. See [Moodboards](moodboards.md).
Team workers retain their scoped coordination tools rather than gaining tools
to create or start separate tasks outside their assignments. Codex registers the
app tools as dynamic functions; other supported local harnesses use the
authenticated, run-local MCP bridge.

Task operations remain within the current project. File previews use the task's
checkout and existing native path validation. Creating a worktree creates a task
under its original project. Starting another agent uses the same admission and
concurrency limits as the UI. Starting/following up on the current running task
is rejected. Use the harness's shell tool for command execution and its image
tool to inspect the local PNG returned by `pandacode_capture_browser`.

A string argument is held to its field's `maxLength` (8 KiB with none), counted in
characters: messages and task descriptions take up to the 16 MiB message limit.
`pandacode_read_task` reads a truncated message to its end with `messageId` and
`offset`, or the description with `offset` alone. `pandacode_list_subagents` does
the same for one subagent with `agentId`, `part` (`response`, `prompt` or `tools`)
and `offset`. A steer that `pandacode_steer_task` could not deliver is an error saying
`Not delivered: <reason>`, and nothing is queued: use `pandacode_queue_message`.

`pandacode_explore` answers many code questions in one call: `search` regexes
matched per line (smart case unless `case_sensitive`; `\n` is refused, as in rg),
with `glob` filters and `context` lines; `symbols` definition lookup (`Type::name`
and `Type.name` narrow `name` to definitions inside or on `Type`, including Go receivers,
C++ out-of-line methods, Kotlin receiver functions and Ruby singleton methods; if none
match the qualifier, unqualified definitions are shown with a note); `outline` of files; ranged `read`s (`path`,
`path:10-40`, `path:10-`, `path#symbol` in a file type it can outline (others say to
read the file instead), or a location such as `path:42`,
`path:42:13` from compiler output or grep's `path:42:text`, which reads lines 32–72);
and `tests_for` changed paths. Any argument may be one string instead of a list, and a
`glob` string such as `"a.ts,src/**,!**/*.test.ts"` is split at commas outside `{…}` and `[…]`
(`\,` is a literal comma, and an item naming a real path is never split); an item with no
glob in it (`","`) or more than 40 globs in all is an argument error; grep
tools' `limit`, `head_limit` and `max_results` are accepted and ignored, since every reply is
capped. It
exists because each extra step re-reads the whole cached prompt, so several lookups in one call
cost one model round trip. It is local and read-only: no network, nothing written to
the checkout, at most four calls at once, at most 64 MiB of file text held per call
(taken by `read`s and `outline`s in the order asked, so which ones fit never depends
on timing; an outline of a file type it cannot outline takes nothing),
and every call is cut short (and says `incomplete`) by its 20-second deadline or the
task's Stop.

**Reply.** Results are grouped by request. A search reply is compact text: each
file's path, then its hit lines with their number, under `@ symbol start-end` for
the definition around them. A search matching more than 12 lines in several files
that does not fit its cap keeps at most two lines a file, definitions first. Within a
file, the part holding a definition is placed first, a part cut short keeps its hit
lines ahead of their context, and a part with no hit line left is never shown. One
search takes at most about 1.8 KB and names the files it had no room for in
`more_files`.

With a `glob`, hits outside it are counted in `outside_glob` (matches and files); only when nothing
matched inside does it also list up to three of those hits (`path:line`), so the
next call need not widen the glob blindly. `coverage` gives the files searched and
`files_in_scope` for globs, and `skipped.secret.count` the secret files the walk
skipped; `glob_warnings` / `glob_errors` explain globs that could not mean what was
asked. `tests_for` lists up to 20 likely test files per path, strongest first (named
for the file, importing it, mentioning it); once one is named for the file or imports
it, at most three that only mention it follow. The rest are counted in
`omitted_tests`. The whole reply, headers, echoed names and call-wide
fields included, stays within 16 KiB: call-wide fields take at most an eighth; reads
are filled first, up to three quarters of the rest (all of it when the call has only
reads); the other requests then share what is left fairly. Anything cut is flagged
with counts (`truncated`, `omitted_lines`, `omitted_files`), and a cut read gives the
range to continue from (`next`) and says to read it before editing. A line too long
for its room is clipped around its match and counted in the request's
`clipped_lines`; that alone never marks the whole reply `truncated`.

**What it will not show.** Searches skip gitignored files and walk only the
checkout and skip symlinks; an explicit `read` or `outline` of a gitignored file
works, and follows a symlink only when its target stays inside the checkout and
passes the same rules. `.git`, symlink escapes, FIFOs and secret paths are refused,
and every file is judged again by its real path once opened, so a folder swapped
for a symlink since the walk is caught unless the swap lands in the moment between
that check and the file's identity check (the path is resolved again, not the open
handle). A glob's `..` is resolved (`src/../web/**` and `src//../web/**` are
`web/**`); one that would leave the checkout or follows a wildcard is refused. Some
roots are refused outright, and the reply says why. Too broad: the home folder or
above (also through `/System/Volumes/Data`), another user's home on this disk
(`/Users/<other>`, `/home/<other>`, `/var/home/<other>`, `/root`, `/var/root`;
`/Users/Shared` is allowed), system folders (`/System` and `/System/Volumes` too),
`/tmp` itself (also as `/private/tmp`; projects in it are allowed),
`/Volumes/<disk>`, `/mnt`, and `Windows` or `ProgramData` at the top of a disk
(`C:\Windows`, WSL's `/mnt/c/Windows`) and anything in them. This home is told apart from another in the
system's case: case-blind on macOS and Windows, exact on Linux, where `/home/Me` is
someone else's. Inside an app-data folder: anything in a dot folder directly in
home (`~/.ssh`, `~/.codex`, `~/.config`, `~/.local`) or under `~/Library` or
`~/AppData` (tool logins, tokens, browser profiles), except a short allowlist:
`~/.config/nvim`, `fish`, `zed`, `helix`, `alacritty`, `kitty`, `wezterm`,
`~/.dotfiles`, `~/.emacs.d`, `~/.vim`, other agent apps' worktrees
(`~/.codex/worktrees`, `~/.cursor/worktrees`, `~/.claude/worktrees`), and the cloud drives
(`~/Library/Mobile Documents`, iCloud Drive and its app folders, and
`~/Library/CloudStorage`: Dropbox, OneDrive, Google Drive, Box). A folder of homes
is only one at the top of a disk: `/Users`, `/home`, `/var/home`, or the same on a
mounted disk (`/Volumes/<disk>/Users`, WSL's `/mnt/c/Users`,
`/media/<user>/<disk>/home`). A home there is refused itself and judged by the same app-data rules, its projects
allowed, and the folder of homes is too broad; a `home` or `users` folder anywhere
else is a project's (`/srv/app/services/users`, `/var/www/home/app`).

Inside a folder that may hold credentials: a root whose path passes through a login
folder (`.ssh`, `.git`, `.aws`, `.config/gh`, `.local/share/keyrings`, at any depth)
or below a credential folder (one named only for credentials and whose they are:
`secrets`, `private_keys`, `my-secrets`, `prod-credentials`); Plan mode also refuses
a root under any unknown dot folder but `.claude/worktrees`, `.codex/worktrees` and
`.cursor/worktrees`. A folder named like an env file (`my.env.tools`, `.env-tools`)
is a folder; `.envs` and `.env.d` hold env files and are refused. The project's own
name never refuses it (`~/code/keychain-swift`, `git-secrets`, `token`, even
`secrets` or `credentials` itself, whose files are then judged by their own names,
since the user chose that folder):
each folder on the way is judged as a folder, and files are judged as the walk meets
them. The home folder comes from `HOME`/`USERPROFILE`, else the system's
record; when none is known, every home on this disk is refused. Two secret rules, in
`src-tauri/src/workspace/secret_paths.rs`, whose module doc lists every step in the
order the code runs them, and where the `CASES` test table decides each example for
both:

- Plain (Standard, Auto edits, Full access) hides clear credential files only, so
  ordinary code stays searchable. By category, with a few examples each (the lists
  in `secret_paths.rs` are the reference):
  - env files: `.env`, `.env.local`, `prod.env`, `app.env.local` (code such as
    `app.env.ts` is exempt);
  - login folders and files: `.git`, `.ssh`, `.aws`, `.netrc`, `.npmrc`, `.pgpass`,
    `.vault-token`, MCP settings (`.mcp.json`, `.cursor/mcp.json`), and the login
    files of `.docker`, `.azure`, `.gradle` or `gh` folders (the rest of those
    folders stays searchable);
  - keys and tokens: `.pem`, `.key`, `.p12`, `id_rsa`, `deploy_key`, `key.json`,
    WireGuard `wg0.conf`, `pat.txt`, and `token` or `tokens` as a word of a name with
    no extension or a text, data or `.token` type (`token.txt`, `tokens.json`,
    `.github_token`, `api.token`, `auth.token.json`; not `token.html`, `tokens.ts` or
    design tokens such as `design-tokens.json`, `design/tokens.json` or
    `src/theme/tokens.json`, under a folder with a design word); a template ending never makes a key a
    template (`server.key.example` is refused);
  - named stores: Terraform state and vars, kubeconfigs, service-account keys,
    Android `key.properties`, `wp-config.php`, `secrets.py`/`.js`/`.rb`;
  - any name containing a credential word (`credentials`, `secret`, `password`,
    `api_key`…), unless it is source code (`service_account.py`, `lib/secret.js`;
    `.sql` never counts) or a template whose other words say what it does with
    them (`password_reset_form.html`; not `admin-passwords-page.html`). A `.txt`
    counts as a mail template only with a singular credential word and a subject
    or email word beside another (`password_reset_subject.txt`, not
    `passwords-email.txt`);
  - docs (`.md`, `.mdx`, `.rst`, `.adoc`) only when the name is one credential word
    and `prod` or `production`: `prod-passwords.md` and `secrets-prod.md` are
    refused; setup guides such as `aws-credentials.md`, `github-tokens.md`,
    `SECRETS.md` and `docs/api-keys.md` are served;
  - shell scripts the same way, without needing an owner word: `secrets.sh` and
    `prod-secrets.sh` are refused, `credential-helper.sh` is served;
  - backups and copies, judged as the file they copy (`server.key.bak`,
    `.pgpass~`, `#server.key#`, `server.key.1`, `id_rsa (1)`, `secrets_old/`);
  - files in a credential folder (`secrets/`, `passwords/`, `keys/`, `my-secrets/`,
    `prod-credentials/`) that are not code, pages and templates
    (`devise/passwords/new.html.erb`, `secrets.component.html`), UI strings
    (`secrets/messages.json`), or docs and pages other than one named for production
    alone: `apps/secrets/models.py`, `secrets/README.md` and `secrets/dev.md` stay
    visible, `secrets/prod.md` and `keys/gcp.json` do not; images there are served
    (`assets/keys/enter.svg`), while `keys/en.json` stays refused;
  - files in a token folder (`tokens/`, `api-tokens/`, which a design system uses
    too) only when named for whose they are: `tokens/prod.json` and
    `api-tokens/github.txt` are refused, `tokens/color/base.json` is served.

  A project's `gradle.properties` and `inventory/hosts.yml` are build files here, as
  are GitHub Actions workflows (`.github/workflows/token.yml`), which read secrets
  by name, unless the name starts with a key prefix (`.github/workflows/id_rsa.yml`).
  Placeholder copies (`secrets.example.yaml`, `credentials.sample.json`)
  are templates, and a `.env.d.ts` declaration is code.
- Strict (Plan mode) also refuses every other dot-name (`.claude`, `.codex`,
  `.vscode`, `.eslintrc`…), `gradle.properties` and `hosts.yml`, and any name that
  merely mentions those words, code and docs included; anything refused under the
  plain rule is refused under the strict one.

Env names whose last part is `example`, `sample`, `template` or `dist`
(`.env.example`, `app.env.sample`, `.env.local.example`) are allowed in both, unless
what comes before `.env` is a credential name itself (`my-secrets.env.example`):
they hold placeholders. Plan mode's own reads (Claude's Read outside the explorer)
still ask before any env file, templates included. A reply always counts the secret
files it skipped, and names what it skipped only when it found nothing or was cut.

**Index and memory.** Small checkouts are scanned on each call. From 4,000 files or
64 MiB, a query builds an in-process trigram index for that root, up to 100,000
files and 4 GiB of files; past those limits it scans and stores nothing. Every
query stat-walks the tree first and re-indexes what changed, so an edit is visible
to the next query. Measured: 20,000 files (vscode) took 44 MiB of table and a
0.7 s cold build; 97,000 files took 164 MiB and 4.6 s. Postings are capped at
256 MiB a root, at most three roots stay in memory, and a root unused for 10
minutes gives its memory back. Nothing is saved to disk.

**Harnesses.** It is registered only where it does not prompt on each call; cloud
runs and tasks on another computer do not get it, because their checkout is not on
this one:

| Harness | How it runs without a prompt | Checked |
|---|---|---|
| Claude Code | exact tool name in the permission callback | live (2.1.317) |
| GLM, MiMo, Alibaba Token Plan | the same callback as Claude Code | code only |
| Codex | `readOnlyHint` in the MCP listing; an approval that still arrives is answered only for this exact server, tool and message | real 0.162.1 app-server against a stub model, all modes; no real model |
| Kimi | its permission request is titled with the tool's registered name, which the harness sets (`buildPermissionToolCallUpdate` in its bundled source); built-in tools (`Bash`…) still ask | live for the MCP frame; built-in frame from source |
| Grok | `use_tool` with the qualified name in `rawInput` | live, Standard and Plan |
| OpenCode | an allow rule for its tool ID `pandacode_architect_pandacode_explore`, added only when this run serves the tool | rule order checked with `opencode debug agent` (OpenCode 1.x; `opencode debug agents` on OpenCode 2.x); no live turn |
| Pi, omp | app tools pass the extension; listed for Plan mode | code only |

OpenCode's permissions are keyed by tool ID, which joins server and tool names, so
the rule cannot name the server alone: a user's server named
`pandacode_architect_pandacode` with a tool `explore` would share the ID.
Grants are merged into `OPENCODE_CONFIG_CONTENT` (preserving unquoted `{env:...}`
and `{file:...}` tokens via sentinel substitution) and fall back to
`OPENCODE_PERMISSION` only for unparseable inline configs.

Hermes, Devin, ZCode, Cursor CLI, Cline, Kilo, GitHub Copilot, DeepSeek, Command Code, Muse and
Antigravity do not get it until a frame recorded from them can be matched. Grok
resolves only `pandacode_architect__pandacode_explore`, so its instructions use that
name; a bare `pandacode_explore` still asks, then fails in the harness.

For Claude Code, PandaCode checks `permissions.deny` and `permissions.ask` in user,
project and local settings (including ancestors up to the nearest Git root and a
linked worktree's inherited main-checkout `.claude/settings.local.json`), plus
enterprise managed settings and `managed-settings.d` JSON drop-ins. Any `Read`,
`Grep`, `Glob`, or PandaCode explore rule withholds the explorer for that launch in
every permission mode. This includes tool-name wildcards such as `Read*`, `R*`,
`Gr*`, `Gl*`, `mcp__*`, `mcp__pandacode_architect__pandacode_*`, and the bare MCP
server name `mcp__pandacode_architect`. Managed settings also apply to Claude-family
relays (GLM, MiMo and Alibaba Token Plan), which otherwise disable user/project
settings. Unreadable, oversized or malformed settings fail closed, as do custom
connection `--settings`, `--setting-sources` or disallowed-tool flags, an unknown
config folder, and Windows registry policies. A connection's `CLAUDE_CONFIG_DIR`
is checked; a connection that only changes the API endpoint or key stays eligible.
New conversations omit the tool and its `LOOK` instruction; resumed conversations
that already listed it refuse its calls. Changed restrictions invalidate warm spares.

Opt-in non-Claude harnesses (Codex, OpenCode, Kimi, Grok, Pi and omp) do not yet
parse their own read-deny settings; the secret rules above still apply to them.

**Instruction.** Runs with the tool get one line in the app instructions (`LOOK` in
`src-tauri/src/lib.rs`): use it to locate code with all questions in one call, and answer
once a reply names the files and symbols needed, searching again only for a named gap.
`look()` then appends one edit sentence by harness (`RunExplore::claude_code`). This section
is the one home of the edit rule; other docs link here.

- **Claude-family writers** (Claude Code and its relays GLM, MiMo and Alibaba Token Plan, any model) get `EDIT_CLAUDE` (154 B): "Before editing a file, Read the lines you need with Read (explore reads don't count). Make each file's changes in as few edit calls as your editor allows."
- **Every other harness** gets `EDIT_OTHER` (66 B): make each file's changes in as few edit calls as the tools allow.
- **A read-only worker** gets neither, only `LOOK` (`look_read_only`), and a run without the tool gets no edit sentence at all.

The edit rule is unmeasured guidance, not a measured saving or a proven requirement. Why Read
first, for every model: Claude Code's Edit may refuse a file its own Read has not
seen, and explore's reads do not count as one. Observed by hand (no transcript kept): on 2.1.323 Sonnet's edits were
accepted and Haiku's refused. The retained runs (2.1.317, bypass mode) recorded no refusals.
A static reading of the minified 2.1.325 bundle suggests the CLI enforces the check outside
bypass and for some models (so Sonnet's acceptance may not hold elsewhere); not verified live.
The text costs a few bytes. Evidence and history:
[the history](agent-loop-benchmark-history.md#edits-without-a-prior-read-recorded-recount).
The text is mode-independent, so it stays in the one cached system prompt. The tool's
description repeats only the stop rule.

Claude Code lists explore, `pandacode_track_files` and the title tool without a ToolSearch step
(`anthropic/alwaysLoad` in the MCP listing). Which harnesses get the tool, and the
permission frames answered for them, are in `src-tauri/src/providers/explore_permissions.rs`.

**Which harnesses get it by default.** Explore is on by default only for Claude Code:
that is the only harness the benchmark measured
([agent-loop-benchmark.md](agent-loop-benchmark.md): Sonnet in Claude Code, nothing
else). Every other harness in `explore_name` (the GLM, MiMo and Alibaba Token Plan relays, which run other
models, and Codex, Kimi, OpenCode, Pi, Oh My Pi, Grok) is supported but stays off until you opt it in
with its own switch, listed under the main switch in Settings → Agents (Claude Code shows there as on by
default). The opt-in is stored as an empty marker file `explore-on-<provider>` in PandaCode's app data,
for example `explore-on-codex` (`explore::enabled_for`); the switches write and remove it through
`explore_harness_enabled`/`set_explore_harness_enabled`, which refuse any harness outside
`explore_name`, and creating the file by hand still works. A harness switch that cannot read its marker
stays disabled, and a refused save puts it back with the reason. The opt-in counts only while the switch below is on; if the
marker cannot be checked, explore stays off for that harness. Off for a harness, its
runs behave exactly as with the switch off.

**Turning it off.** **Settings → Agents → Local code explorer (pandacode_explore)**
is on by default. Off, runs get no instruction line for it and a new conversation
does not list the tool; a resumed conversation that may already hold it keeps it
listed and refuses every call (`src-tauri/src/app_instructions/catalog.rs`). The
next turn starts a fresh agent process (the setting changes the warm-agent key).
Harnesses other than the Claude family receive that line inside their messages, so
an existing conversation keeps the old line in its history; it names a tool the run
no longer has, which is harmless. The setting is a marker file, `explore-off`, in app
data (`src-tauri/src/explore.rs`), read at each run start, so `pandacode serve`
follows it too; if app data cannot be found or the marker cannot be checked, the
tool stays off, and Settings shows it off when it cannot ask.

`pandacode_code_search` (Codex's dynamic tools only; other harnesses do not get it)
searches the task's checkout through the local third-party `codedb` CLI when it is
installed and on the app's PATH: a text query by default, or symbol search with
`symbols: true`. It is read-only and runs as one bounded process per query (64 KiB of
output, a 30-second deadline) with `CODEDB_NO_TELEMETRY=1`; there is no daemon or
resident index service, and nothing is written inside the project (codedb keeps its
own index data in its home directory). Results are untrusted data. When codedb is
absent the tool says so, and agents keep their harness's own search tools. The tool
runs without an approval prompt, like the other read-only app tools.

Host callbacks are outside the harness's shell sandbox, so PandaCode enforces its
own approval boundary: mutations and browser/UI access request approval in Standard
and Auto modes, are unavailable in Plan mode, and run without a prompt only when
the user selected Full access. Browser access requires the calling task to be
visible; background tasks cannot hijack another task's browser. The browser
interface accepts a finite action and data, never agent-provided JavaScript or
generic native IPC. Remote page text is untrusted content. Remote webviews have
no application IPC access.

The installed app-server persists dynamic tools with newly created threads.
Its `thread/resume` API cannot add them to a conversation created without them.
Older tasks retain their original coding/MCP tools; start a new Codex task to use
newly added PandaCode app tools. Existing Codex team leads receive the expanded
catalog through the team's normal context handoff, preserving bounded text history.
Claude, GLM, Kimi, OpenCode, and other supported local harnesses receive these
host tools on each run (optional ones such as `pandacode_explore` ride the same bridge). ACP harnesses must advertise HTTP MCP support. ZCode bridges the same
per-run loopback catalog through `session/create` `mcpServers` (and `mcp/list` connect on resume,
and before the prompt when the tools are required), and cloud runs do
not receive local host tools.
Provider-owned tools and integrations continue through their own protocols and
configuration.

## Agent-made tools

`pandacode_tool_save`, `pandacode_tool_run` and `pandacode_tool_list` let agents save a
repeated job as a named script and run it again in any task of the project. Runs ask for
approval unless the task runs in Full access. See [Agent-made tools](custom-tools.md).

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
