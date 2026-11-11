# Skill manager

Settings → Tools → **Skills** lists every skill installed for any harness on this computer, switches skills off for
**All projects** or for one project, and adds skills with the [`skills` CLI](https://skills.sh). **Add skill** is the
only way to add skills (it takes owner/repo, GitHub and GitLab URLs, skills.sh links and folders). **Rules & library**
([skills-library.md](skills-library.md)) is about rules; its link at the top opens this page, and
a bot library skill's **Install for agents…** opens Add skill here with the source prefilled and already finding (`requestAddSkill(source)` in `skill-manager-model.ts`: a
`pandacode:skill-manager-add` event plus a pending `{ source }` the page claims when it mounts).
The old skill **Catalogs** (repositories indexed in Rules & library) were removed: Add skill reads repositories
directly, and the saved catalog list (`<app data>/skills/.catalogs.json`) is no longer read or used.

## Behaviour

**Switches.** One switch per skill name (agents address skills by name, so same-named skills share it). Off in
**All projects** is off in every project, and a project can't turn it back on (the project row is locked). Switches
apply from the next turn (native reads them every turn); they never change the installed files and only affect tasks
and consoles PandaCode starts, including bots and worktree tasks (each launch resolves its owning project), never an
agent's own terminal sessions outside PandaCode. Cloud and mirror tasks use this (host) computer's switches, and
skills installed only on a cloud machine aren't listed. Some agents can only be asked not to use an off skill, and some
consoles aren't told at all (see Enforcement); the page says so with **May still load**.

**Scope.** The page opens on the current project, the project of the active thread (the host's `activeProject()`),
when the picker offers it, else on All projects. A labelled **Show skills for** filter: small pills (a radio group,
arrow keys move) for up to three scopes, else a select, then an info mark (**Switches apply in PandaCode, for the
scope picked here. Agents PandaCode runs follow them from the next turn; files stay installed.**); there is no
switch-column caption, the picker already says where switches act. A project view lists the project's own skills
first, tagged **This project**; All projects tags project skills with their project names. A tag's tooltip says
**Installed in orbit**, or **Also installed in orbit** when agents' home folders hold the skill too. While another
scope loads, the old list stays, dimmed and inert (`aria-busy`), with its open rows still open; they close when the
new list lands, and stay open if it fails. If that read fails, the picker goes back to the scope still shown (so picker and list agree)
and the error line names the scope that failed, **Couldn’t load skills for orbit.** with native's reason and **Retry**
(which tries that scope again); the list shown stays usable. A failed refresh of the scope already shown keeps that
list dimmed and inert until **Retry**. With nothing loaded yet the error takes the list's place.

**Summary line.** The count of installed skills and what is off: `12 skills · 1 off in all projects`; in a project,
skills off via All projects count apart from the project's own (`… · 1 off in all projects · 1 off in orbit`, a skill
off in both counts once). A leftover setting (`missing`) counts nowhere, not as a skill, an off skill or a search
match (`2 of 10 skills`). Off skills that may still load are bracketed, so the headline never overstates "off":
`2 off in all projects (1 may still load)` counts off skills where some installed agent using them isn't blocked, in
tasks (`enforcement` `asked` or `none`) or in PandaCode's consoles (`consoleEnforcement` `asked` or `none`). Then
`N+ folders not shown` when the bounded scan skipped folders, and any transient note (an install's result, **Every
skill is back on.**, **Restored docx.**). The counts wrap rather than truncate (only on a page too narrow for them).
Once a switch changes, **· Applies from the next turn** joins the summary on the same line, whole or not at all: it
takes only the room the counts leave, and where it doesn't fit it stays hidden (no width; the info mark says the same),
so a switch never moves the rows. Changing scope clears it.

**Switching.** Optimistic: the switch moves at once, saves go out in order, and each answer (a full inventory) is
applied whole, re-applying switches still saving. A failed save puts the switch back and explains beside the row
(`Couldn’t turn docx off: …`); if the user picked another scope meanwhile, the floating line at the bottom of the view
says it instead, naming the skill and scope (`Couldn’t turn docx off in all projects: …`, with **Dismiss**). A switch flipped while the same scope's list is being read is saved, and the list
is read again after it, so the flip is never dropped. After a switch, reset, install, restore or uninstall the page
dispatches `pandacode:skill-manager-changed` (`SKILLS_CHANGED_EVENT`); Rules & library re-reads and tags library
skills switched off here **Off in Skills**.

**Rows.** A disclosure (title, two-line description) with a meta line under it, harness chips, then the switch.
Descriptions come first: chips are logos, with agent names for the whole view or for none (`data-names` on the list's
body). Names show only when the list is at least 680px wide (Settings at 1200px), no untagged row carries more than
two chips, and every untagged row then keeps at least 60% of its width (and 300px) for its title and description;
otherwise names stay in each chip's tooltip and accessible name. A row that also carries a tag (a project chip,
**May still load**) keeps logos only (`data-compact`). An agent app missing on this computer gets a dashed chip that
always names it in text, **Kimi Code** over **missing** (two short lines, no logo, no wider than a logo chip, so
no row wraps differently), whether or not names show (tooltip and accessible name **Kimi Code
app missing**; never "not installed", which reads as if the skill weren't). Details list each location in one compact layout at every width: the agent's name in a narrow
label column with its path right beside it, then scope and what that harness does with an off skill (**Won’t load
when off**, **Asked when off**, **Not enforced when off**, plus the console's when it differs and native's
`consoleNote`, or **App missing**) on a line of its own under both; then the source.

| Row state | What it shows |
| --- | --- |
| Off, but may still load | A quiet **May still load** tag before the switch. It takes keyboard focus (the tooltip opens on focus too) and describes the switch; it names the agents and why (`Pi can only be asked not to use it. In its console, Kimi Code isn’t told to skip it.`). |
| Locked (project view, off in All projects) | Meta line **Off in all projects** and a **Manage** link that opens All projects with that row's switch focused (its **Clear** for a `missing` row, which has no switch); the switch is drawn locked. |
| `switchable: false` | Disabled switch with a lock; `unswitchableReason` is its tooltip and detail. |
| `quarantined` | **Quarantined** and **Restore…** (warning tone, alert glyph: never mistaken for **Manage**) in the meta line, no switch (an empty slot keeps the chips aligned). Details lead with the reason and the flagged files (`flags`, up to three, then `+N more`). |
| `quarantinedCopy` | Switch works for the clean install; **Copy quarantined** and **Restore…** in the meta line. The copy's locations load nowhere: no chips, no **May still load**, not an install target. |
| `missing` | **Not installed** and a **Clear** link (accessible name **Clear the setting for …**) in the meta line, no switch; never a bare tag. In All projects Clear shows whenever any switch holds it (`offInPandaCode` or `offInProjects`), followed by **Off in orbit** naming the projects that hold it; Clear (`skill_manager_set` `enabled: true`, no `projectId`) clears every one and the row leaves. In a project view Clear clears that project's switch; where All projects holds it off, **Manage** instead. |

Every state tag in the meta line (**Off in all projects**, **Off in orbit**, **Not installed**, **Quarantined**,
**Copy quarantined**) is one quiet hairline chip (`.skill-row-tag`), like **May still load**.

Restore asks first inside the row (Cancel / **Restore anyway**, naming the first finding unless the details are
open), then applies `skill_manager_restore`'s inventory. Findings come from the row's `flags`; records from older
builds have none, so the page falls back to the last add's `findings`, else says the safety check flagged it.

**Uninstall.** An open row's details end with **Uninstall…**, at the right end of the Source line, when the view has a copy to remove (user-level copies
in All projects, the project's own in a project, including copies in its task worktrees; quarantined copies are Restore's). It asks first, naming the scope,
then shows **Uninstalled pdf from all projects.** with **Undo** on one glass line floating at the bottom of the view
(sticky after the list, so it never pushes a row) until the next uninstall; Undo takes focus without scrolling.
While that line shows, the scroller reserves its height (`scroll-padding-bottom`), and a control that takes focus
under it scrolls just clear of it; the end of the list rests clear of it.
Copies PandaCode didn't put there (including links it made in agents' account homes under earlier builds) are left
in place and named on that line (`kept`). A `kept` entry ending in native's reason, ` (in a folder above this project,
shared with the projects under it)` (Pi's ancestor `.agents/skills` in a monorepo), is listed after **Left in
place:** with that reason; when only such copies exist native refuses the uninstall (**This skill's copies here are
shared with other projects, so PandaCode left them in place: …**) and the row shows that error. When native drops older Undo
records (`expiredUndo`), a quiet line under it says **Older uninstalls can no longer be undone (…).** Undo fails, and
the line says why, if something now occupies an original path, while an install runs, or once its record is gone.

**Notices.** Whatever needs saying above the list shares one compact area (`data-sm-notices`): the settings card,
a failed read with **Retry**, then the calm lines, separated by hairlines. The area is a card only while the settings
warning shows; a failed read or calm lines alone stay quiet lines. Buttons there are compact, so each notice is a line
or two and the list starts near the top however many speak at once.

**Settings file problems.** `prefsError` shows a card: **Couldn’t read skill settings** with **Reset switches** on the same line, then **All skills
are off until you reset.** (`prefsLost`: nothing recovered) or **Using the last saved switches until you reset.**
followed by native's detail in quiet text. **Reset switches** explains itself and asks before **Turn every skill back on**. `prefsWarning`
(names kept off because they no longer pass the name policy) is one calm line, hidden while `prefsError` shows;
`linksWarning` is another calm line under it, nothing to click: `skill-manager-links.json` (the record of links
PandaCode made in Codex, OpenCode, Pi and Kilo account homes) is unreadable, or was moved aside this session to the
timestamped `.backup` file the text names.

## Files

- UI: `src/skill-manager.ts` (state, events), `src/skill-manager-view.ts` (markup), `src/skill-manager-model.ts`
  (IPC types, pure helpers), `src/skill-manager-add.ts` (Add skill), `src/skill-manager.css`.
- Native: `src-tauri/src/skill_manager.rs` (commands, inventory, roster) and `skill_manager/`: `matrix.rs` (the one
  enforcement table), `enforcement.rs` (Codex `skills.config`, OpenCode denies), `opencode_agents.rs`, `prefs.rs`
  (`skill-manager.json`, recovery, reset), `disabled.rs` and `launch.rs` (a launch's switches), `inventory.rs`,
  `roots.rs`, `metadata.rs`, `plugins.rs`, `cli.rs` (`npx skills`), `install.rs`, `accounts.rs`, `safety.rs`,
  `quarantine.rs`, `uninstall.rs`. Typed-command guard and composer catalog: `slash_commands/skill_switches.rs`.
- Preview mock: `src/preview-skill-manager.ts`, which builds each harness's modes from
  `tests/fixtures/skill-matrix.json` (generated from `matrix.rs`; a Node test checks they agree).

## IPC

```ts
type SkillAgent = { harness: string; scope: 'user' | 'project'; path: string; projectId?: string; quarantined?: true };
type SkillEnforcement = 'blocked' | 'asked' | 'none';
type SkillModes = { enforcement: SkillEnforcement; consoleEnforcement: SkillEnforcement };
type SkillFlag = { rule: 'secret' | 'approvals' | 'pipe-to-shell' | 'scan-limit'; file: string; line: number; excerpt: string };
type ManagedSkill = { name: string; description: string; agents: SkillAgent[]; offInPandaCode: boolean; offInProject: boolean;
  offInProjects: string[]; source: string | null; switchable?: boolean; unswitchableReason?: string;
  enforcementOverrides?: Record<string, SkillModes>; quarantined?: true; quarantinedCopy?: true; flags?: SkillFlag[]; missing?: true };
type SkillHarness = { id: string; installed: boolean; enforcement: SkillEnforcement; consoleEnforcement: SkillEnforcement;
  consoleNote?: string; installable: boolean; installAs?: string };
type SkillInventory = { projectId: string | null; harnesses: SkillHarness[]; skills: ManagedSkill[]; notShown?: number;
  findings?: (SkillFlag & { skill: string; quarantined?: true })[]; failures?: { skill: string; reason: string }[];
  switchedOff?: string[]; // add only: names this add itself switched off in its scope
  prefsError?: string; prefsLost?: true; prefsWarning?: string; linksWarning?: string; error?: string };
  // prefsLost: only with prefsError, when nothing was recovered. linksWarning: skill-manager-links.json unreadable or backed up.
type Uninstalled = { id: string; name: string; removed: string[]; kept: string[]; switchesCleared: boolean; // kept: a path, maybe ' (reason)'
  expiredUndo?: string[]; expiredUndoIds?: string[] };

skill_manager_list({ projectId? }) -> SkillInventory                    // no projectId: All projects
skill_manager_set({ name, enabled, projectId? }) -> SkillInventory
skill_manager_reset({ projectId? }) -> SkillInventory                   // resets every switch; projectId picks the view returned
skill_manager_preview({ source }) -> { source: string; skills: { name; description; switchable?; unswitchableReason? }[]; selected?: string[] }
skill_manager_add({ source, skills, harnesses, projectId? }) -> SkillInventory   // no projectId: global (-g)
skill_manager_add_library({ source, skills }) -> { imported: { id; name }[]; findings; failures }  // Bot library only
skill_manager_restore({ name, projectId? }) -> SkillInventory           // projectId picks the view returned
skill_manager_uninstall({ name, projectId? }) -> SkillInventory & { uninstalled: Uninstalled }
skill_manager_undo_uninstall({ id, projectId? }) -> SkillInventory
bots_list() -> Bot[]                                                    // Add offers Bot library only with a bot
```

- Every set, reset, restore, uninstall and undo answer is a full inventory for the view asked.
- `projectId: null` is All projects: user roots plus project roots of up to 256 registered projects; project agents
  carry `projectId` and `offInProject` is false. `offInProjects` lists project IDs with a project switch off (All
  projects), or the current project when its switch is off (project view).
- `enforcement`/`consoleEnforcement` are a harness's modes for an identifier name; `enforcementOverrides` lists only
  harnesses whose modes differ for that skill. The page derives nothing from names (missing modes read as asked).
- `installable`/`installAs`: the CLI agent ID Add groups by (Claude Code/GLM/MiMo `claude-code`, Pi/OMP `pi`,
  DeepSeek/Muse Code `universal`, Kimi Code `kimi-code-cli`, ZCode `zcode`).
- `notShown`: a lower bound on folders the bounded scan skipped (not a skill count), omitted when zero.
- `quarantined`: an add flagged it and PandaCode moved the folders that install created into app data
  (`skill-quarantine/`), removing links it made. Quarantine is not a switch. A name with a clean install too stays
  one row with `quarantinedCopy` and the copy's locations marked `quarantined`. `flags`: at most 20, excerpts
  redacted. Restore moves every quarantined copy back; it fails if something occupies the original path, and
  refuses a second restore of the same skill in flight. A retried Restore skips items already back in place.
- Moves (quarantine, uninstall, Restore, Undo) rename; only a cross-volume rename error falls back to copying. The
  copy's source is first renamed aside to a hidden `.<name>.removing-<uuid>` beside it, then deleted; if that rename
  fails the copy is removed and the source is untouched. A delete that fails partway leaves (and logs) that hidden
  folder, never a half-deleted skill. Any other rename error fails without copying.
- An add that updates a flagged copy already installed switches the name off where it went: a project-scoped add only
  in that project (`offInProjects`), an add for All projects in all projects. `switchedOff` lists the names whose
  switch in that scope the add turned off (omitted when none); a name already off there is not listed.
- Inventory ignores hidden `.<name>.removing-<uuid>` leftovers, so a failed delete never shows as a skill.
- `missing`: a saved switch for a name no longer installed (`agents: []`). Turning it on clears it (no `projectId`:
  the global and every project switch); turning it off is refused.
- `skill_manager_set` refuses an invalid name, a name the view doesn't list, a missing skill turned off
  (`This skill is no longer installed. Refresh the skill list and try again.`) and an unresolved identity.
- Uninstall moves this view's copies into `skill-uninstalled/` (recorded in `skill-uninstalled.json`), unlinks links
  PandaCode made and keeps the rest (`kept`); with no copy left in the view it clears the skill's switches
  (`switchesCleared`). `skill-uninstalled.json` stays under 256 KB; the oldest records expire (their kept copies deleted) and are reported in `expiredUndo` (names) and
  `expiredUndoIds`, omitted when none. Undo restores files and cleared switches once per `id`; like Restore, a retried Undo resumes, skipping items already back in place. Undo and Restore count an item as already back only when an earlier attempt really put it back (its `put_back` mark, and it is still in place); otherwise a missing kept copy is an error.
- Name policy: names with spaces or Unicode stay switchable. Over 200 bytes, control characters, a leading `-`,
  commas, parentheses, backticks, angle brackets and wildcards return `switchable: false`. Names render as text only.
- Switches live in `skill-manager.json` in app data (off everywhere, and per project ID; older path keys migrate).
  A corrupt file: list recovers the last good preferences and returns `prefsError`; with nothing recoverable launches
  still start with every skill off until reset. Saving and adding need a strict read. Reset backs up the old files
  with timestamped names and writes empty preferences.
- Roots: Claude plugin skills (`plugin:skill`), `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`, saved
  connection and account-pool homes, universal `.agents/skills`, Muse's roots, Pi's ancestor `.agents/skills` up to the
  repository root, and project worktrees. Paths under home show as `~/…`; other homes as account labels.

## Enforcement

One table (`skill_manager/matrix.rs`) is read by launches, consoles, the typed-command guard and this page.
`blocked`: the harness won't load the skill (its files stay readable, so it is not a sandbox). `asked`: PandaCode adds
a JSON-quoted instruction not to use it. `none`: nothing reaches the agent. Identifier: ASCII letters, digits, `-_.:`.

| Harness | Tasks (identifier) | Consoles (identifier) | Other names (tasks / consoles) | How |
| --- | --- | --- | --- | --- |
| Claude Code, GLM, MiMo | blocked | blocked | asked / asked | `Skill(name)` disallowed-tool rules merged with existing ones; other names get a system-prompt reminder. `consoleNote`: a `/name` typed in the console is expanded before any rule applies |
| Codex | blocked | blocked | blocked / blocked | session `skills.config` name selectors; the user's config is untouched |
| OpenCode | blocked | blocked | asked / **none** | skill permission denies for every agent (`opencode_agents.rs`), also through `OPENCODE_PERMISSION` and as `"<name> *"` keys so later layers can't reorder them; consoles have no reminder channel |
| Pi, OMP, Grok, Muse, Hermes | asked | asked | asked / asked | reminder; consoles use a system-prompt flag, Muse `run.developer_prompt`, Hermes `HERMES_EPHEMERAL_SYSTEM_PROMPT` |
| Kimi, Antigravity, DeepSeek, Command Code, Kilo, ZCode, GitHub Copilot, Devin (and any other) | asked | none | asked / none | reminder in tasks only |
| Cline | asked | **none** | asked / none | reminder in tasks; `cline --system` would replace the whole system prompt |

- The task reminder is appended to each turn's prompt; on a turn starting with `/<name>` or `/skill:<name>` of an
  installed skill it goes on a trailing line of its own. Claude-family (other names) and Pi/OMP carry it in the
  system prompt; Codex never needs it.
- **Typed commands:** a turn starting with `/<name>` or `/skill:<name>` for a skill switched off for that task and
  installed for its harness is refused with `<name> is switched off in Settings → Skills.` Harness built-ins are
  exempt (every Codex `/` command); a same-named custom command runs. Steers and queue edits run the same guard. On
  Claude-family harnesses a typed `/tool` that uniquely names an off plugin skill `plugin:tool` is refused too. A
  skill attached with the picker that is off is refused the same way.
- Off skills' own slash commands leave the composer catalog and are never injected as Codex skill parts.
- A named connection's arguments can't undo switches (Codex gets a final `-c skills.config=[…]`). If OpenCode's agent
  list is incomplete, that launch also gets the reminder.
- After unrecoverable settings: Claude-family and OpenCode deny all skills, Codex denies each installed skill by
  name, the others get `Skills are temporarily off in this session: …`, until **Reset switches**.
- Warm and pooled launches honour switches; changing them invalidates warm reuse.
- **Bots:** an off skill is not synced into the bot's workspace (an earlier copy is deactivated next turn), not
  inlined and not announced; it is listed under "Skills left out" as `<name> is off in Skills.`

## Adding skills

- **Source:** owner/repo (or owner/repo/path), a GitHub or GitLab HTTPS URL, a skills.sh link (normalized to
  owner/repo; `selected` preselects the named skill), or a folder on this computer (**Choose folder…** or a typed
  absolute path containing `SKILL.md` or `skills/`; network paths, `.`/`..` segments and control characters are
  refused). Native echoes the canonical source, which add sends back.
- **Found skills:** name and two-line description; a name that can't be switched shows disabled with its reason and
  is never installed. Skills already installed at the chosen target for every chosen agent are marked
  **Installed** and left unchecked.
- **Agents:** one box per CLI agent ID; installed agents start checked, others are listed unchecked, marked **app
  missing** (**apps missing** for a box that groups several), so a skill can be added before its agent is. **Install to:** All projects (each agent's home folder) or a project's checkout; choices survive a
  source change.
- **Bot library** (offered only with a bot): `skill_manager_add_library` installs into a private staging folder,
  scans, imports clean skills into PandaCode's library for bots, and deletes the staging folder. Agents' folders
  don't change.
- **CLI:** `npx -y skills@1.7.6` (one pinned constant) with PandaCode's own `--prefix=<app data>/skills-cli`, so
  project npm config is never used. Global adds then link into Codex, OpenCode, Pi and Kilo account homes without
  overwriting user folders. Adds run one at a time.
- **Safety:** add scans installed folders (bounded; secrets masked in excerpts). Folders the install created that
  have findings are quarantined; existing folders it only updated are switched off where the add went: in that
  project for a project add, in All projects otherwise. The dialog stays open for findings, failures or `error` and
  shows only the result (Source, **Choose folder…** and the hint step aside; **Done** takes focus): a warning heading
  **Flagged by the safety check**, then per flagged skill its name with **Restore anyway** or **Turn on anyway**, one
  line per finding in the rows' compact format (rule, `file:line`, redacted excerpt), and where it stands:
  **Quarantined until you restore it. Agents can’t load it in any project.**, **Off in orbit until you review it.** /
  **Off in all projects until you review it.** Then **Installed: …** for the skills that installed cleanly, then
  failures. **Turn on anyway** shows only for names in the add's `switchedOff` (native's own record of the switches
  it set; never a list read before the add, so a failed or late read can't clear a switch the user set). It clears
  that same switch (`skill_manager_set` with the add's `projectId` for a project add) and then says **On in orbit.** /
  **On in all projects.** Any other flagged name that wasn't quarantined (already off there, or an older build that
  sends no `switchedOff`) gets no button and **Stays off in orbit, as it was before.** An add that returns `error`
  still offers **Turn on anyway** for names in its `switchedOff`, and claims nothing for the rest. A bot library add's result has the same heading and
  findings, **Not added: the safety check flagged it.**, then what was added.
- **Result note:** compares the add's answer with the list already on the page (harness, scope, project, location),
  never counting a flagged skill as installed: `Installed 2 skills for Claude Code · 1 skill off for review.`,
  `1 skill quarantined for review.`, or **Already installed.**

## Privacy

Nothing runs until you click **Find skills** (or choose a folder) or **Install**. Then `npx` may download the
`skills` package from the registry in your `~/.npmrc` (by default `registry.npmjs.org`), and the CLI reads the source
you chose. PandaCode runs it with `DISABLE_TELEMETRY=1` and `DO_NOT_TRACK=1`, a 120 s limit and no Git prompts.
Listing and switching are local only.
