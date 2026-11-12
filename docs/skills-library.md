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

Each activation records the harness, scope, project checkout, surface, the library hash it wrote, the SHA-256 of every file or block it wrote, any `.git/info/exclude` lines it added, and the exclude list those lines are in.

## Adapters (`src-tauri/src/skills/adapter.rs`)

| Harness | Skill, user | Skill, project | Rule, user | Rule, project |
|---|---|---|---|---|
| Claude Code | `~/.claude/skills/<id>/` | `<checkout>/.claude/skills/<id>/` | block in `~/.claude/CLAUDE.md` | block in `<checkout>/CLAUDE.md` |
| Codex | `~/.codex/skills/<id>/` | `<checkout>/.agents/skills/<id>/` | block in `~/.codex/AGENTS.md` | block in `<checkout>/AGENTS.md` |
| Others | `prompt` | `prompt` | `prompt` | `prompt` |

- A rule block is wrapped in `<!-- pandacode:rule:<id> -->` … `<!-- /pandacode:rule:<id> -->`. PandaCode changes only its own block. In project scope, an existing rule file is rewritten through a temporary file that is renamed over it, so a failed write leaves the file as it was, including your text outside the block. In user scope the file is rewritten in place, so a failed write there can lose text.
- Temporary files are named `.<name>.pandacode-<uuid>.tmp` and sit beside the file they replace. One is removed when its write fails. If PandaCode crashes or is killed mid-write, it stays behind and shows in `git status`; delete it by hand.
- PandaCode never writes into a skill folder it did not create, never overwrites a file or block whose hash differs from what it wrote, and on deactivation leaves edited files in place (`Change.kept`).
- Harnesses marked `prompt` only record the activation. Nothing injects these items into prompts yet (see Not yet).

### Links

- In project scope, PandaCode never follows a broken link, or a link whose resolved target is outside the project or inside its Git folder (`.git`).
- A write through such a link is refused with `<path> is a link; PandaCode does not write through links.`
- A removal through one leaves the file in place and reports it as kept (`Change.kept`).
- A link inside the project is followed only from one rule file (`CLAUDE.md`, `AGENTS.md`) to another, or from a skills folder to a skills folder. So `AGENTS.md -> CLAUDE.md` and `.agents/skills -> ../.claude/skills` are written through. Any other link is refused with the same message.
- An activation is refused when a link leads to a file or folder PandaCode already manages for another harness, with `<path> is a link to <real>, which PandaCode already manages for <harness>.` An example is one rule for Claude Code and Codex with `AGENTS.md -> CLAUDE.md`. When the path is not a link, the message is `PandaCode already manages <path> for <harness>.`
- The target is checked again after it is resolved, just before the write. A small timing gap remains: a parent folder swapped for a link between that check and the open is still followed. Removals have the same gap: the links are checked, then the file is removed.
- User scope (your home folder, such as a dotfiles-linked `~/.claude/CLAUDE.md`) writes through links as before.
- In either scope, removing the last block through a link empties the link's target. The link itself is not deleted.

### Hard links and non-regular files

- On macOS and Linux, PandaCode refuses to write to a project file that has other hard links, with `<path> is hard-linked elsewhere; PandaCode does not write through hard links.`
- A FIFO, device or other non-regular file at a target path is refused.
- For a skill file the message is `<path> is not a regular file; PandaCode will not write to it.`
- For a rule file the message is `<path> is not a text file PandaCode can add to.`

### Exclude list

- In a Git checkout, project scope adds the skill folder to the checkout's exclude list. A rule file is added only when PandaCode created that file.
- The line uses the path where the files actually land. So with `.agents/skills -> ../.claude/skills` the line is `/.claude/skills/<id>/`.
- Gitignore's special characters in the path are escaped with a backslash, so the line matches only that literal path. These are `*`, `?`, `[` and `\` anywhere, a leading `!` or `#`, and trailing spaces. For example, if a Codex project's `.agents/skills` is a link to `../.claude/skills/a*b`, the line is `/.claude/skills/a\*b/<id>/`. This is the only way a folder can sit between `skills` and `<id>`.
- A path with a control character (such as a newline in a cloned folder's name) is refused with `"<path>" has a control character in its path; PandaCode will not add it to the Git exclude list.` The activation fails before any file is written.
- The list is `info/exclude` under the folder from `git rev-parse --git-common-dir`, so linked worktrees share their main checkout's list.
- A line is added only when that Git folder is inside the repository (the top level from `git rev-parse --show-toplevel`), or when the checkout is a linked worktree whose `.git` file and the worktree's `gitdir` file point at each other. Otherwise no line is added.
- Submodules and repositories made with `--separate-git-dir` keep their Git folder outside the checkout. Their own checkout gets no exclude line, and its files show in `git status`.
- A linked worktree (`git worktree add`) of such a repository passes the worktree check, so it does get a line, in that outside Git folder's `info/exclude`.
- If `info` or `info/exclude` is a link, the update is refused with `<path> is a link; PandaCode does not update the Git exclude list through links.`
- If `info/exclude` can't be read as text (unreadable, not UTF-8, or not a regular file), it is left unchanged. The message is `Could not read the Git exclude list <path>: <reason>. PandaCode left it unchanged.`; for a file that is not UTF-8, the reason is `it is not UTF-8 text`. An activation fails with this message and writes nothing. When a line should be removed, it stays and the failure is only logged.
- An existing `info/exclude` is replaced whole: the new text goes to a temporary file beside it, which is then renamed over it. So a failed update leaves the list as it was. A missing list is created new.
- Passing `sessionId` scopes the activation to that task's worktree.

### Shared lines

- One line can cover files of several activations. Examples: a second rule in a `CLAUDE.md` that the first one created, or the same skill in another worktree of the repository.
- Turning an activation off (or moving it to a new folder) keeps a line while another activation still has files under it. That activation then owns the line, and the last one relying on it removes it.
- When turning off keeps an edited file (`Change.kept`), the file is no longer managed. Its line is removed unless another activation still relies on it, so the kept file shows in `git status`.
- Each activation records which exclude list its lines are in. If its checkout was deleted, turning it off still releases its lines in that list: a line is handed to another activation that still relies on it, or else removed. A recorded list path is edited only while it still looks like a Git `info/exclude`: a file named `exclude` in an `info` folder, whose parent holds `HEAD` and an `objects` folder or a `commondir` file, with no link along the path. It must also belong to the activation's own repository: either the checkout's Git folder still lists the checkout as a worktree, or another live activation of the same repository uses that list. Any other recorded path is left unchanged, and that is only logged.
- Records from older builds have no exclude list. If such an activation's checkout is gone, each of its lines is handed to another activation in the same repository whose list still has it. Otherwise the line is left in place, and that is logged.
- A recorded line is removed only if it is one PandaCode adds for that activation: the line for its own skill folder (or, for Codex in a project, the old `.codex/skills/<id>/` folder) or its rule file, as built for the checkout. Once the checkout is gone, the line must end in that folder or file's path within the checkout. Any other recorded line (`/src/` in an edited record) stays in the list, and that is logged.
- If handing a line over or removing it fails, the change still goes through. The failure is only logged, and the line stays in the list.

### Failed writes

- Every file is checked before anything is deleted or written.
- Recorded paths are checked too. A path in an activation's record that is not where that skill or rule is written for its harness and scope (its own skill folder, or its rule file) is never removed or rewritten. It is logged and reported as kept. So a damaged or edited record can't make PandaCode delete or rewrite other files.
- The exclude line is added after these read-only checks pass and before any skill file is written. So a refused check, or a refused or failed exclude update, writes nothing.
- A file the new version adds is refused up front if something PandaCode did not write is already at its path: `<path> already exists and PandaCode did not write it; move it away and try again.` So a file you put in a skill folder yourself never makes an update fail halfway. A recorded file under another spelling of its name counts as PandaCode's (on a case-insensitive disk, `README.md` replacing `Readme.md` is the same file), so a case-only rename goes through.
- If a skill file write fails partway on a first activation, the files that call finished writing are removed. Finished files that had to stay are named in the error (`Left in place: …`).
- If it fails partway while updating an active skill, the files that call created are removed, including a recorded file you had deleted that it wrote again. Files it replaced are put back the same way as for a failed save: rewritten as recorded, so the record still matches the disk.
- A replaced file is put back only while it holds the previous version or the new one this call wrote. A file someone changed in the meantime is not overwritten. If the previous version can't be put back, the error names the files left holding something else (`Left in place: …`).
- A new skill file that failed partway is removed too, with folders left empty, but only while it holds nothing but a start of the new text. On macOS and Linux it must also still be the same file with no other links. So a retry of a first activation finds a free folder and works.
- In project scope, a skill file's previous version is replaced through a temporary file and a rename, so the file whose write failed keeps its old version.
- A rule file the call created is removed again when its write fails, but only while it holds nothing but a start of the new text. On macOS and Linux it must also still be the same file with no other links.
- If the write fails, the exclude line this call added is taken out again. Files left behind are not hidden and show in Git.
- Moving an activation to a new folder removes the old copy, and releases its exclude lines, only after the new record is saved. If the save fails, the old copy stays installed and recorded.
- If the activation can't be saved after the write, it is rolled back the same way: the files it wrote are removed, its exclude line is taken out, and files that had to stay are named (`Left in place: …`).
- If taking the exclude line out fails, the error says so: `Could not remove the exclude line <line>: <reason>.` Otherwise a refused or failed activation leaves no exclude line behind.
- Turning off a project activation whose checkout has been deleted drops its record and reports nothing as kept, since there is nothing left to keep.
- Only a project activation with no recorded project path (Turn off everywhere) has its record dropped and its files left in place and reported as kept.

### Windows

- If the project root can't be resolved (some Windows drives), every link is refused. Plain paths still work.
- The timing gap also covers the file itself: a link swapped in for it before the open is not caught.
- There is no hard-link check.
- When a created rule file's write fails, a file of the same length counts as the same file, since its identity can't be compared.

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
