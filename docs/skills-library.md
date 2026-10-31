# Skills library and rules registry

Issues #15 (skills) and #45 (rules). This is a small first version. It lets you import a skill or rule once, turn it on for each harness and scope, and see what each installed harness actually has.

The import form keeps the local path field at its full control height. Its Kind, Source and Project menus use the current theme's text and solid panel colors, including unselected options in Windows native menus.

## Storage

Everything is files under the app data folder. There is no schema migration.

```
<app data>/skills/<id>/SKILL.md     skill (the folder keeps its other files)
<app data>/skills/<id>/RULE.md      rule (one Markdown file)
<app data>/skills/<id>.json         Meta: source (folder path or owner/name/path, ref, commit),
                                    content SHA-256, acknowledged hash, activations
<app data>/skills/.catalogs.json    Catalog sources, the last discovery report, and repositories
                                    discovery found without skills (by pushed_at)
```

Each activation records the harness, scope, project checkout, surface, the library hash it wrote, the SHA-256 of every file or block it wrote, and any `.git/info/exclude` lines it added.

## Adapters (`src-tauri/src/skills/adapter.rs`)

| Harness | Skill, user | Skill, project | Rule, user | Rule, project |
|---|---|---|---|---|
| Claude Code | `~/.claude/skills/<id>/` | `<checkout>/.claude/skills/<id>/` | block in `~/.claude/CLAUDE.md` | block in `<checkout>/CLAUDE.md` |
| Codex | `~/.codex/skills/<id>/` | `<checkout>/.codex/skills/<id>/` | block in `~/.codex/AGENTS.md` | block in `<checkout>/AGENTS.md` |
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

## Repository catalogs and discovery (#114, #115)

`skills/catalog.rs`. A catalog source is a GitHub repository indexed for skills, kept apart from the library and from activation.

- Scanning reads the commit for the ref, then one recursive Git tree. Every `SKILL.md` (at the root, `skills/<name>/`, or deeper in nested collections) counts only when its frontmatter has both `name` and `description` (YAML `>`/`|` block values work). A repository named "skills" without such a file is never registered. Hidden paths are skipped. A skill's files are its folder minus any nested skill folder.
- Importing copies the chosen skills (or all of them) at the indexed commit, each with its supporting files and `owner/name/path`, ref and commit as its source. Nothing is activated. The 64-file and 1 MB limits apply per skill, and a skill over them is skipped with a reason. Per-catalog limits: 20,000 tree entries, 300 `SKILL.md` files, and a truncated GitHub tree, each refused with a clear error.
- Same names: each indexed skill lists other catalog paths and library items with the same id (`conflicts`). An import whose id the library already holds from another source is skipped, never overwritten.
- Refresh re-reads the index only. A library copy keeps its commit (`imported`), and the UI says when a newer version is upstream. Importing again updates the library, and harnesses then show `outdated`, as before.
- Discovery (`skills_discover`) uses the same `gh` login as GitHub import, with no new scopes. It lists `user/repos?affiliation=owner` 100 at a time, up to 10 pages; organizations are not scanned. Matching repositories are registered as `discovered` sources. Ignored and disabled sources are left alone, unchanged repositories (same `pushed_at`) are not read again, and empty ones are skipped, so repeating discovery is idempotent. A rate limit or sign-in failure stops discovery with a clear message after saving progress; other per-repository failures are listed in the report.
- Settings shows the sources with Refresh, Disable/Enable and Ignore (ignored sources are listed with Stop ignoring), each source's skills with checkboxes, and Import selected / Import all.

## Commands

`skills_list()`, `skills_import_folder({ path, kind })`, `skills_import_github({ repo, path, gitRef?, kind })`, `skills_activate({ id, harness, scope, projectId?, sessionId?, acknowledge? })`, `skills_deactivate({ id, harness, scope, projectId?, sessionId? })`, `skills_matrix({ projectId?, sessionId? })`, `skills_scan({ id })`, `skills_remove({ id })`, `skills_catalogs()`, `skills_catalog_add({ repo, gitRef? })`, `skills_catalog_refresh({ repo })`, `skills_catalog_state({ repo, state })` (`enabled`, `disabled` or `ignored`), `skills_catalog_import({ repo, paths? })` (returns `{ items, imported, skipped }`), `skills_discover()`. Here `kind` is `skill` or `rule`, and `scope` is `user` or `project`. Activate and deactivate return `{ items, kept }`.

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
                skills::skills_matrix,
                skills::skills_scan,
                skills::skills_remove,
                skills::skills_catalogs,
                skills::skills_catalog_add,
                skills::skills_catalog_refresh,
                skills::skills_catalog_state,
                skills::skills_catalog_import,
                skills::skills_discover,
```

`src/settings.ts`:

```ts
import { mountSkillsLibrary, type SkillsLibraryHost } from './skills-library';
// SettingsSection union: add 'skills'
export type SettingsSection = 'general' | 'appearance' | 'agents' | 'providers' | 'teams' | 'tools' | 'skills' | 'cloud' | 'remote' | 'github' | 'about';
// SettingsOptions:
  /** Skills library and rules registry. */
  skills?: SkillsLibraryHost;
// SECTIONS, after 'tools':
  { id: 'skills', label: 'Skills & rules', icon: 'widget', description: 'Import skills and rules once, turn them on per harness, and check for drift.' },
// sectionHtml():
    case 'skills': return '<div id="skills-library"></div>';
// mountSection():
    if (id === 'skills' && options.skills) cleanups.push(mountSkillsLibrary(panel.querySelector<HTMLElement>('#skills-library')!, options.skills));
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
    case 'skills_deactivate': case 'skills_matrix': case 'skills_scan': case 'skills_remove':
    case 'skills_catalogs': case 'skills_catalog_add': case 'skills_catalog_refresh': case 'skills_catalog_state': case 'skills_catalog_import': case 'skills_discover':
      result = previewSkills.call(command, args); break;
```

`playwright.config.ts`, `testMatch`: add `'**/skills-library.spec.ts'`. The spec mounts the section on its own page, so it passes before or after the Settings wiring.
