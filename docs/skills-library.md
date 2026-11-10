# Skills library and rules registry

Issues #15 (skills) and #45 (rules). This is a small first version. It is about rules: import a rule once, turn it on for each harness and scope, and see what each installed harness actually has.

Skills are added in one place: Settings → Tools → **Skills** → **Add skill** ([skill-manager.md](skill-manager.md)), which takes owner/repo, a GitHub or GitLab URL, a skills.sh link or a local folder. This page has no catalogs and no skill import; everything here that leads to a skill opens that dialog (`requestAddSkill(source)`; Settings follows the button's `data-section="skills"`).

The page, top to bottom: one intro line, **Import a rule**, **Rules** (the library's rules, each with its per-agent boxes), **Bot library** (the library's skills; the heading, its list and the intro's sentence about it appear only when it has any), then **By harness**.

- The intro says exactly that: **Import rules and turn them on per agent. The bot library holds skills for bots only. To add or switch skills, use Skills.** (the middle sentence only with a bot library). Its **Skills** link opens the Skills page; the rule import card has no second pointer.
- A library item's source (a path or `GitHub · owner/repo`) is monospace and wraps only after its separators, never mid-name; a single part wider than the line ellipsizes, with the whole source in its tooltip.
- Skills for bots only come in through Add skill's **Install to → Bot library** (`skill_manager_add_library`), which imports them into this library without touching any agent folder; such items have `source.kind` `folder` (a local folder) or `skills` (location: the source). The **Bot library** heading's info mark says so.
- A bot library skill's **Install for agents…** opens Add skill on the library's own copy (`<app data>/skills/<id>`) as a local-folder source, already finding, to install it for agents. It needs the copy's absolute path as `folder` on the `skills_list` item (`<app data>/skills/<id>`, skills only); without it the button is not shown. The browser preview's library (`src/preview-skills.ts`) reports it under `LIBRARY_DIR`.

Bot library skills are listed read-only: no per-agent boxes. Copies activated by older builds stay where they are; the Skills page lists them as installed skills, and here they read **In use by Claude Code. Switch it in Skills, or turn it off everywhere to remove it.** with **Turn off everywhere…** in place of **Remove** (native refuses to remove an item while anything is active). It asks first, then calls `skills_deactivate_all`, which undoes every activation the item recorded, in each harness, scope and checkout, and leaves files edited since in place (`kept`, named in the status line); **Remove** then appears. Nothing in the library is deleted by this change.

It lives at Settings → Tools → **Rules & library** (page id `rules`); the page id `skills` is the
[Skill manager](skill-manager.md). A link at the top opens the Skills page. Installed skills are listed only there:
the **By harness** table (**Rules by harness**) and the **Rules found on disk, not managed by PandaCode** card list
rules only (native's `skills_matrix` still reports both kinds; the page drops `kind: "skill"` entries), and that card
uses the design system's `ds-card`. Library skills switched off there
(read from `skill_manager_list` for the library's project, matched by name or slug id) show an **Off in Skills**
tag (accessible name says **in Settings → Tools → Skills**; tooltip **Off in all projects in Settings → Tools → Skills:
blocked or asked, per agent.**, since some agents won't load an off skill and others can only be asked) that opens the Skills page; the tag refreshes when the Skills page dispatches `pandacode:skill-manager-changed`.
If that list can't be read the tags are simply absent.
Each item's source line (a path, or **GitHub · owner/repo/skill @ commit**) breaks only after a slash or before `@ commit`, never mid-name; a part still wider than the line ellipsizes, with the whole source in its title.

**Skills** controls what agents may use and adds skills; **Rules & library** turns rules on per harness and scope.
Skills switches are keyed by name, so same-named skills share one switch, and act only on agents PandaCode runs.
Enforcement details say **Won’t load when off**, **Asked when off** or **Not enforced when off**; an off skill some
agent may still load is tagged **May still load** there.

The **Import a rule** form (Source **Local file** — a rule is one Markdown file — or **GitHub repository** with a path) keeps the **File path** field at its full control height. Its **Source** and **Project scope** selects are labelled in visible text beside them and use the current theme's text and solid panel colors, including unselected options in Windows native menus. `skills_import_folder` and `skills_import_github` still accept `kind: "skill"` natively; the page simply no longer offers it.

## Storage

Everything is files under the app data folder. There is no schema migration.

```
<app data>/skills/<id>/SKILL.md     skill (the folder keeps its other files)
<app data>/skills/<id>/RULE.md      rule (one Markdown file)
<app data>/skills/<id>.json         Meta: source (folder path or owner/name/path, ref, commit),
                                    content SHA-256, acknowledged hash, activations
```

Each activation records the harness, scope, project checkout, surface, the library hash it wrote, the SHA-256 of every file or block it wrote, and any `.git/info/exclude` lines it added.

## Adapters (`src-tauri/src/skills/adapter.rs`)

| Harness | Skill, user | Skill, project | Rule, user | Rule, project |
|---|---|---|---|---|
| Claude Code | `~/.claude/skills/<id>/` | `<checkout>/.claude/skills/<id>/` | block in `~/.claude/CLAUDE.md` | block in `<checkout>/CLAUDE.md` |
| Codex | `~/.codex/skills/<id>/` | `<checkout>/.agents/skills/<id>/` | block in `~/.codex/AGENTS.md` | block in `<checkout>/AGENTS.md` |
| Others | `prompt` | `prompt` | `prompt` | `prompt` |

- A rule block is wrapped in `<!-- pandacode:rule:<id> -->` … `<!-- /pandacode:rule:<id> -->`. Text outside the block is never changed.
- PandaCode never writes into a skill folder it did not create, never overwrites a file or block whose hash differs from what it wrote, and on deactivation leaves edited files in place (`Change.kept`).
- In a Git checkout, project scope adds the skill folder (and a rule file, but only when PandaCode created that file) to `info/exclude`. The path comes from `git rev-parse --git-path info/exclude`, so worktrees work too. Passing `sessionId` scopes the activation to that task's worktree.
- Harnesses marked `prompt` only record the activation. Nothing injects these items into prompts yet (see Not yet).

## Matrix and safety

- `skills_matrix` lists each installed file harness (its CLI is on PATH or `~/.<harness>` exists), plus any prompt harness in use. Each cell is `active`, `outdated` (a newer library version is not activated yet), `drifted`, `missing`, `prompt` or `off`. It also lists skill folders PandaCode does not manage, unknown PandaCode blocks, and instruction files with text PandaCode does not manage.
- Importing again updates the library only. Harnesses keep the old version and show `outdated` until you activate again.
- The safety scan (`skills/safety.rs`) flags secret-shaped tokens and named secrets, instructions that turn off approvals or the sandbox, and downloads piped into a shell. If an item has findings, activation fails until the user calls it with `acknowledge: true`. That acknowledgement is stored per content hash.
- GitHub import uses `gh api` through `github::run_gh` (`workspace::run_process`). Limits: 64 files and 1 MB.

## Repository catalogs (removed)

Earlier builds indexed GitHub repositories as catalogs (`skills/catalog.rs`, `skills_catalog*`, `skills_discover`).
That code, its commands and the Catalogs section are gone, and the saved catalog list (a leftover
`<app data>/skills/.catalogs.json`) is no longer read or used: Add skill on the Skills page reads repositories, so
there is one place to add skills.

## Commands

`skills_list()`, `skills_import_folder({ path, kind })`, `skills_import_github({ repo, path, gitRef?, kind })`, `skills_activate({ id, harness, scope, projectId?, sessionId?, acknowledge? })`, `skills_deactivate({ id, harness, scope, projectId?, sessionId? })`, `skills_deactivate_all({ id })`, `skills_matrix({ projectId?, sessionId? })`, `skills_scan({ id })`, `skills_remove({ id })`. Here `kind` is `skill` or `rule`, and `scope` is `user` or `project`. Activate, deactivate and deactivate-all return `{ items, kept }`.

## Not yet

Prompt injection for prompt harnesses (that belongs with the token saver's send-time block), role and task scopes beyond a session worktree, version diffs with promote/skip/pin, folding the Token saver packs into the library, GitLab (single imports and catalogs), organization discovery, conflict detection between rules.

## Wiring

These hunks fall outside the module's files.

`src-tauri/src/lib.rs`, module list (next to `mod token_saver;`):

```rust
mod skills;
```

`src-tauri/src/lib.rs`, `generate_handler!` (after `token_saver::token_saver_install,`):

```rust
                skills::skills_list,
                skills::skills_import_folder,
                skills::skills_import_github,
                skills::skills_activate,
                skills::skills_deactivate,
                skills::skills_deactivate_all,
                skills::skills_matrix,
                skills::skills_scan,
                skills::skills_remove,
```

`src/settings.ts` (the page ids live in `src/settings-sections.ts`: `SettingsPage` includes `'skills' | 'rules'`, and
the Tools group lists **Add-ons**, **Skills** and **Rules & library**):

```ts
import { mountSkillManager } from './skill-manager';
import { mountSkillsLibrary, type SkillsLibraryHost } from './skills-library';
// SettingsOptions:
  /** Skills manager and Rules & library. */
  skills?: SkillsLibraryHost;
// sectionHtml():
    case 'skills': return '<div id="skill-manager"></div>';
    case 'rules': return '<div id="skills-library"></div>';
// mountSection():
    if (id === 'skills' && options.skills) cleanups.push(mountSkillManager(panel.querySelector<HTMLElement>('#skill-manager')!, options.skills));
    if (id === 'rules' && options.skills) cleanups.push(mountSkillsLibrary(panel.querySelector<HTMLElement>('#skills-library')!, options.skills));
```

`src/main.ts`, in the `mountSettings` options next to `cloud: { call, … }`:

```ts
      skills: { call, projects: () => userProjects().map(p => ({ id: p.id, name: p.name })) },
```

`src/preview.ts`:

```ts
import { createPreviewSkills } from './preview-skills';
const previewSkills = createPreviewSkills();
// in invoke()'s switch, before `default:`
    case 'skills_list': case 'skills_import_folder': case 'skills_import_github': case 'skills_activate':
    case 'skills_deactivate': case 'skills_deactivate_all': case 'skills_matrix': case 'skills_scan': case 'skills_remove':
      result = previewSkills.call(command, args); break;
```

`playwright.config.ts`, `testMatch`: add `'**/skills-library.spec.ts'`. The spec mounts the section on its own page, so it passes before or after the Settings wiring.
