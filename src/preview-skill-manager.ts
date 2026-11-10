/* Project ids match src/preview.ts (project-1 orbit, project-2 pandacode).
 * Browser preview of the skill manager (src-tauri/src/skill_manager.rs): skills across Claude Code,
 * Codex and OpenCode, two projects with their own skills, and a pretend `skills` CLI. */
import type { LibraryAdd, ManagedSkill, Uninstalled, PreviewSkill, SkillAgent, SkillEnforcement, SkillHarness, SkillInventory, SkillModes, SkillPreview } from './skill-manager-model';

/** Like the model's isLocalSource (kept apart so Node's tests load this file without a bundler): an absolute folder. */
const isLocalSource = (source: string): boolean => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(source.trim());
/** Like native's `network_path` (skill_manager/cli.rs): two leading separators (`\\server\share`, `//host`, `\\?\…`). */
const isNetworkPath = (source: string): boolean => /^[\\/]{2}/.test(source.trim());
const NETWORK_FOLDER = 'Choose a folder on this computer: network folders can\'t be added.';

import SKILL_MATRIX from '../tests/fixtures/skill-matrix.json' with { type: 'json' };

type Fixture = Omit<ManagedSkill, 'offInPandaCode' | 'offInProject' | 'offInProjects'> & { project?: string };
const DELAY_MS = 250;
/** Native's one enforcement table (src-tauri/src/skill_manager/matrix.rs) for an identifier name, generated into
 * tests/fixtures/skill-matrix.json: per harness its modes, optional console note and skills CLI agent id. */
export type MatrixRow = { enforcement: SkillEnforcement; consoleEnforcement: SkillEnforcement; consoleNote?: string; installAs?: string };
export const MATRIX: Readonly<Record<string, MatrixRow>> = SKILL_MATRIX as Record<string, MatrixRow>;
/** Where a name outside `IDENTIFIER` differs (matrix.rs): Claude-family rules can only ask, OpenCode asks in tasks
 * and can't tell its console. Every other harness treats all switchable names alike. */
const NON_IDENTIFIER: Readonly<Record<string, SkillModes>> = {
  claude: { enforcement: 'asked', consoleEnforcement: 'asked' }, glm: { enforcement: 'asked', consoleEnforcement: 'asked' },
  mimo: { enforcement: 'asked', consoleEnforcement: 'asked' }, opencode: { enforcement: 'asked', consoleEnforcement: 'none' },
};
/** A harness's modes for a skill whose name is (`identifier`) or isn't made only of ASCII letters, digits and `-_.:`. */
function modes(id: string, identifier: boolean): SkillModes {
  const row = MATRIX[id] ?? { enforcement: 'asked', consoleEnforcement: 'none' };
  return (!identifier && NON_IDENTIFIER[id]) || { enforcement: row.enforcement, consoleEnforcement: row.consoleEnforcement };
}
const IDENTIFIER = /^[A-Za-z0-9_.:-]+$/;
/** Like native: only harnesses whose modes for this name differ from their defaults; omitted when none. */
function overridesFor(name: string): Pick<ManagedSkill, 'enforcementOverrides'> {
  // Like native's `overrides`: names that can't be switched at all report none.
  if (IDENTIFIER.test(name) || !switchableName(name)) return {};
  const entries = Object.keys(MATRIX).map(id => [id, modes(id, false)] as const).filter(([id, m]) => {
    const base = modes(id, true);
    return m.enforcement !== base.enforcement || m.consoleEnforcement !== base.consoleEnforcement;
  });
  return entries.length ? { enforcementOverrides: Object.fromEntries(entries) } : {};
}
/** One harness as native lists it: its matrix row, installed or not on this pretend computer. */
export function previewHarness(id: string, installed: boolean): SkillHarness {
  const { consoleNote, installAs, ...m } = MATRIX[id] ?? { enforcement: 'asked', consoleEnforcement: 'none' };
  return { id, installed, installable: !!installAs, ...(installAs ? { installAs } : {}), ...m, ...(consoleNote ? { consoleNote } : {}) };
}
const HARNESSES: SkillHarness[] = [
  previewHarness('claude', true), previewHarness('codex', true), previewHarness('opencode', true),
  previewHarness('kimi', false), previewHarness('deepseek', false), previewHarness('muse', false),
];
const ROOTS: Record<string, string> = { claude: '.claude/skills', codex: '.codex/skills', opencode: '.config/opencode/skills', kimi: '.kimi/skills', deepseek: '.agents/skills', muse: '.agents/skills' };
const user = (harness: string, name: string): SkillAgent => ({ harness, scope: 'user', path: `~/${ROOTS[harness] ?? `.${harness}/skills`}/${name}` });
const project = (harness: string, name: string): SkillAgent => ({ harness, scope: 'project', path: `${(ROOTS[harness] ?? `.${harness}/skills`).replace('.config/opencode', '.opencode')}/${name}` });
const skill = (name: string, description: string, harnesses: string[], source: string | null = null): Fixture =>
  ({ name, description, source, switchable: true, agents: harnesses.map(h => user(h, name)) });
const projectSkill = (projectId: string, name: string, description: string, harnesses: string[]): Fixture =>
  ({ name, description, source: null, switchable: true, project: projectId, agents: harnesses.map(h => ({ ...project(h, name), projectId })) });

const BASE: Fixture[] = [
  skill('pdf', 'Extract text, tables and forms from PDF files, and fill or merge them.', ['claude', 'codex'], 'anthropics/skills'),
  skill('docx', 'Create and edit Word documents with tracked changes and comments.', ['claude'], 'anthropics/skills'),
  skill('frontend-design', 'Distinctive, production-grade interfaces that avoid generic AI aesthetics.', ['claude', 'opencode'], 'anthropics/skills'),
  skill('webapp-testing', 'Drive a local web app with Playwright to check behaviour and capture screenshots.', ['claude', 'codex', 'opencode'], 'anthropics/skills'),
  skill('react-best-practices', 'Performance patterns for React and Next.js from the Vercel team.', ['codex', 'opencode'], 'vercel-labs/agent-skills'),
  skill('release-notes', 'Draft release notes from merged pull requests since the last tag.', ['claude']),
  skill('changelog', 'Keep CHANGELOG.md in the Keep a Changelog format.', ['codex']),
  skill('sql-review', 'Review migrations for locking, missing indexes and irreversible steps.', ['opencode']),
  skill('mcp-builder', 'Build Model Context Protocol servers in TypeScript or Python.', ['claude', 'codex'], 'anthropics/skills'),
  // Kimi Code isn't installed in the preview: its chip says 'app missing'.
  skill('brand-guidelines', 'Apply the company colours, type and voice to anything you make.', ['claude', 'kimi']),
  projectSkill('project-1', 'orbit-deploy', 'Deploy Orbit to staging and production with the right flags.', ['claude', 'codex']),
  projectSkill('project-1', 'orbit-fixtures', 'Regenerate the API fixtures after a schema change.', ['claude']),
  projectSkill('project-2', 'tauri-ipc', 'Add a Tauri command with its preview mock and Playwright spec.', ['opencode']),
];
/** What every local folder holds in the preview, including a name native can't switch (listed with its reason). */
const LOCAL_KEY = 'local folder';
const CATALOG: Record<string, PreviewSkill[]> = {
  [LOCAL_KEY]: [
    { name: 'house-style', description: 'Our naming, formatting and review checklist.' },
    { name: 'oncall-runbook', description: 'Triage alerts, find the service that owns them, page the right owner, and keep the incident channel updated until it is resolved and written up.' },
    { name: 'draft (old)', description: '', switchable: false, unswitchableReason: 'PandaCode can\'t switch a skill with this name, so it can\'t be added from here.' },
  ],
  'vercel-labs/agent-skills': [
    { name: 'react-best-practices', description: 'Performance patterns for React and Next.js.' },
    { name: 'web-design-guidelines', description: 'Review UI code against interface guidelines.' },
    { name: 'vercel-deploy', description: 'Deploy to Vercel and read build logs.' },
  ],
  // Another repository the preview can add from.
  'you/agent-skills': [
    { name: 'changelog', description: 'Keep CHANGELOG.md in the Keep a Changelog format.' },
    { name: 'triage', description: 'Label and route new issues.' },
  ],
  'anthropics/skills': [
    { name: 'xlsx', description: 'Spreadsheets with formulas and charts.' },
    { name: 'pptx', description: 'Slide decks from outlines.' },
  ],
};
/** Where native keeps Rules & library's own copies (`<app data>/skills/<id>`), as the preview library
 * (src/preview-skills.ts) reports each skill's `folder`; Add finds one skill there. */
export const LIBRARY_DIR = '/Users/you/Library/Application Support/PandaCode/skills';
/** A library copy holds one skill, named for its folder. */
const libraryPreview = (source: string): PreviewSkill[] | null => {
  const folder = source.trim().replace(/[\\/]+$/, '');
  return folder.startsWith(`${LIBRARY_DIR}/`) ? [{ name: folder.slice(LIBRARY_DIR.length + 1), description: 'A skill from Rules & library.' }] : null;
};
const wait = (ms = DELAY_MS) => new Promise(resolve => setTimeout(resolve, ms));
const INVALID_SOURCE = 'Enter owner/repo, owner/repo/path, a GitHub/GitLab HTTPS URL, or a skills.sh package name.';
const INVALID_LINK = 'Invalid skills.sh link.';
const LOCAL_FOLDER = 'Choose an existing folder that contains SKILL.md or a skills folder.';
const SOURCE_CHARS = /^[A-Za-z0-9\-_.@:/]+$/;
const SEGMENT_CHARS = /^[A-Za-z0-9\-_.@]+$/;
const NO_LONGER_INSTALLED = 'This skill is no longer installed. Refresh the skill list and try again.';
const UNRESOLVED_IDENTITY = "This skill's identity could not be resolved safely; review its SKILL.md before switching it.";
const fail = (message: string): never => { throw new Error(message); };
const parseUrl = (text: string, message: string): URL => { try { return new URL(text); } catch { return fail(message); } };

/** Mirrors `validate_source` in skill_manager.rs: owner/repo[/path] or a GitHub, GitLab or skills.sh HTTPS URL. */
function validateSource(source: string): void {
  if (!source || source.length > 1024 || source.startsWith('-') || !SOURCE_CHARS.test(source)) fail(INVALID_SOURCE);
  let path = source;
  if (source.startsWith('https://')) {
    const url = parseUrl(source, INVALID_SOURCE);
    if (!['github.com', 'gitlab.com', 'skills.sh'].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash) fail(INVALID_SOURCE);
    const rest = source.slice('https://'.length), slash = rest.indexOf('/');
    if (slash < 0) fail(INVALID_SOURCE);
    path = rest.slice(slash + 1);
  }
  if (!path.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('-') && SEGMENT_CHARS.test(part))) fail(INVALID_SOURCE);
}

/** Mirrors `validate_toggle_name` in skill_manager.rs. */
function switchableName(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !!name.trim() && new TextEncoder().encode(name).length <= 200 && !name.startsWith('-') && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029,()`<>*]/.test(name);
}
function validateName(name: string): void {
  if (!switchableName(name)) fail("This skill name can't be switched: use at most 200 bytes, without control characters, a leading '-', commas, parentheses, backticks, angle brackets or wildcards.");
}

/** Mirrors `normalize_source` in skill_manager/cli.rs: a `https://skills.sh/<owner>/<repo>[/<skill>]` link (query
 * and trailing slashes ignored) becomes owner/repo plus the named skill; anything else is validated and passed
 * through unchanged (the skills CLI resolves GitHub and GitLab URLs itself). */
export function parseSource(source: string): { source: string; selected?: string[] } {
  // Like native: an absolute folder on this computer is the source ('.'/'..' segments and control characters refused).
  if (isNetworkPath(source)) fail(NETWORK_FOLDER);
  if (isLocalSource(source)) {
    // eslint-disable-next-line no-control-regex
    if (source.trim().split(/[\\/]/).some(part => part === '.' || part === '..') || /[\u0000-\u001f\u007f]/.test(source)) fail(LOCAL_FOLDER);
    return { source: source.trim() };
  }
  if (!source.startsWith('https://skills.sh/')) { validateSource(source); return { source }; }
  // eslint-disable-next-line no-control-regex
  if (source.length > 1024 || /[\u0000-\u001f\u007f-\u009f]/.test(source)) fail(INVALID_LINK);
  const parts = parseUrl(source, INVALID_LINK).pathname.replace(/\/+$/, '').split('/').slice(1);
  if (parts.length < 2 || parts.length > 3) fail('Enter a skills.sh owner/repo or owner/repo/skill link.');
  const repo = `${parts[0]}/${parts[1]}`;
  validateSource(repo);
  if (parts.length < 3) return { source: repo };
  validateSource(parts[2]);
  validateName(parts[2]);
  return { source: repo, selected: [parts[2]] };
}

/** The mock catalog key the `skills` CLI would resolve a source to: GitHub and GitLab URLs name owner/repo. */
const catalogKey = (source: string): string => {
  if (isLocalSource(source)) return LOCAL_KEY;
  if (!source.startsWith('https://')) return source;
  const [owner = '', repo = ''] = new URL(source).pathname.split('/').filter(Boolean);
  return `${owner}/${repo.replace(/\.git$/, '')}`;
};
const normalize = (source: string) => catalogKey(parseSource(source).source);
/** The source recorded for an installed skill: the folder itself for a local source. */
const recordedSource = (source: string) => isLocalSource(source) ? parseSource(source).source : normalize(source);

/** Like native's quarantine record: the skill's findings, at most 20, without the skill name; omitted when none. */
const MAX_FLAGS = 20;
function flagsFor(name: string, findings: SkillInventory['findings']): Pick<ManagedSkill, 'flags'> {
  const flags = (findings ?? []).filter(f => f.skill === name).slice(0, MAX_FLAGS).map(({ rule, file, line, excerpt }) => ({ rule, file, line, excerpt }));
  return flags.length ? { flags } : {};
}

/** `quarantinedCopies`: names that also have a quarantined copy beside their clean install (for another agent).
 * Like native, the row stays one per name: switchable as usual, `quarantinedCopy: true`, the copy's locations
 * appended to `agents` marked `quarantined`, and the copy's findings as `flags`.
 * `bots`: the user's bots by name (`bots_list`), so Add offers 'Bot library' only when there is one.
 * `notShown`: the lower bound of folders native's bounded scan skipped (skill_manager.rs `notShown`).
 * `quarantined`: fixture names flagged by the safety check and moved aside until `restore`.
 * `missing`: names switched off in all projects that are no longer installed (rows with no agents).
 * `missingInProjects`: by project id, names no longer installed that only that project's switch holds off.
 * `prefsLost`: with `prefsError`, nothing readable was left, so (like native's `*`) every skill is off until reset;
 * the inventory then says so with `prefsLost: true`, as native's does.
 * `prefsWarning`: native's note about names kept off because they no longer pass validation.
 * `linksWarning`: native's note about skill links it couldn't follow or put back (sent with every inventory). */
/** Where Add → Bot library imports: the preview's skills library (src/preview-skills.ts) in the app preview, or a
 * small in-memory one of its own in specs. */
export type PreviewBotLibrary = {
  importSkills(source: string, skills: readonly PreviewSkill[]): { imported: { id: string; name: string }[]; failures: { skill: string; reason: string }[] };
};
function memoryLibrary(): PreviewBotLibrary {
  let held: ReadonlyMap<string, string> = new Map();
  return {
    importSkills(source, skills) {
      const result: ReturnType<PreviewBotLibrary['importSkills']> = { imported: [], failures: [] };
      for (const skill of skills) {
        const from = held.get(skill.name);
        if (from && from !== source) result.failures.push({ skill: skill.name, reason: `${skill.name} is already in the library from ${from}.` });
        else { held = new Map([...held, [skill.name, source]]); result.imported.push({ id: skill.name, name: skill.name }); }
      }
      return result;
    },
  };
}

export function createPreviewSkillManager(options: { prefsError?: string; prefsLost?: boolean; prefsWarning?: string; linksWarning?: string; installError?: string; findings?: SkillInventory['findings']; harnesses?: SkillHarness[]; notShown?: number; skills?: Fixture[]; quarantined?: string[]; quarantinedCopies?: string[]; missing?: string[]; missingInProjects?: Readonly<Record<string, readonly string[]>>; library?: PreviewBotLibrary; bots?: string[]; undoLimit?: number } = {}) {
  const library = options.library ?? memoryLibrary();
  const quarantinedNames = new Set(options.quarantined ?? []);
  const base = options.skills ?? BASE;
  let fixtures: Fixture[] = [
    ...base.map(f => quarantinedNames.has(f.name) ? { ...f, quarantined: true, ...flagsFor(f.name, options.findings) } : f),
    // A copy the safety check moved aside, for an agent the clean install doesn't use.
    ...(options.quarantinedCopies ?? []).flatMap(name => base.filter(f => f.name === name).slice(0, 1).map((f): Fixture => {
      const harness = ['codex', 'opencode', 'claude'].find(h => !f.agents.some(a => a.harness === h)) ?? 'codex';
      return { ...f, quarantined: true, agents: [user(harness, name)], ...flagsFor(name, options.findings) };
    })),
    ...[...new Set([...(options.missing ?? []), ...Object.values(options.missingInProjects ?? {}).flat()])]
      .map((name): Fixture => ({ name, description: '', source: null, switchable: true, agents: [], missing: true })),
  ];
  let prefsError = options.prefsError;
  let denyAll = !!options.prefsError && !!options.prefsLost;
  let offEverywhere: ReadonlySet<string> = new Set(options.missing ?? []);
  let offByProject: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(Object.entries(options.missingInProjects ?? {}).map(([id, names]) => [id, new Set(names)]));
  /** A missing skill is listed only while some switch still holds it off. */
  const held = (name: string) => offEverywhere.has(name) || Object.values(offByProject).some(set => set.has(name));

  const inventory = (projectId?: string): SkillInventory => {
    const off = (projectId && offByProject[projectId]) || new Set<string>();
    const skills = fixtures.filter(f => (!projectId || !f.project || f.project === projectId) && (!f.missing || held(f.name))).map(({ project: _, ...f }): ManagedSkill => ({ ...f,
      ...overridesFor(f.name),
      offInPandaCode: denyAll || offEverywhere.has(f.name), offInProject: off.has(f.name),
      offInProjects: Object.keys(offByProject).filter(id => offByProject[id].has(f.name)),
    }));
    // Like native: one row per name. A quarantined copy beside a clean install folds into the clean row
    // (`quarantinedCopy`, its locations marked `quarantined`, its findings as `flags`).
    const merged = new Map<string, ManagedSkill>();
    const place = (agent: SkillAgent) => `${agent.harness}\n${agent.path}`;
    for (const entry of skills) {
      const key = `${entry.quarantined ? 'q' : 'c'}\n${entry.name}`, existing = merged.get(key);
      const agents = existing ? [...existing.agents, ...entry.agents.filter(a => !existing.agents.some(b => place(a) === place(b)))] : entry.agents;
      merged.set(key, existing ? { ...existing, agents } : entry);
    }
    const rows = [...merged.values()].filter(row => !row.quarantined || !merged.has(`c\n${row.name}`)).map((row): ManagedSkill => {
      const copy = row.quarantined ? undefined : merged.get(`q\n${row.name}`);
      if (!copy) return row;
      const { flags: _, ...clean } = row;
      return { ...clean, quarantinedCopy: true, agents: [...row.agents, ...copy.agents.map(agent => ({ ...agent, quarantined: true as const }))], ...(copy.flags ? { flags: copy.flags } : {}) };
    });
    return {
      projectId: projectId ?? null, harnesses: options.harnesses ?? HARNESSES,
      skills: rows.sort((a, b) => a.name.localeCompare(b.name)),
      ...(prefsError ? { prefsError } : {}), ...(prefsError && denyAll ? { prefsLost: true } : {}), ...(options.prefsWarning ? { prefsWarning: options.prefsWarning } : {}),
      ...(options.linksWarning ? { linksWarning: options.linksWarning } : {}), ...(options.notShown ? { notShown: options.notShown } : {}),
    };
  };
  let uninstalls = 0;
  /** Undo records, oldest first; past `undoLimit` the oldest expire, as native's do past their file limit. */
  let undos: ReadonlyMap<string, { name: string; fixtures: Fixture[]; offEverywhere: ReadonlySet<string>; offByProject: Readonly<Record<string, ReadonlySet<string>>> }> = new Map();
  const toggle = (set: ReadonlySet<string>, name: string, enabled: boolean): ReadonlySet<string> => {
    const next = new Set(set);
    if (enabled) next.delete(name); else next.add(name);
    return next;
  };

  return {
    list(args: { projectId?: string }): SkillInventory { return inventory(args.projectId); },
    /** `bots_list`, reduced to what Add reads: one entry per bot. */
    bots(): { id: string; name: string }[] { return (options.bots ?? []).map((name, i) => ({ id: `bot-${i + 1}`, name })); },
    reset(args: { projectId?: string }): SkillInventory {
      offEverywhere = new Set();
      offByProject = {};
      prefsError = undefined;
      denyAll = false;
      return inventory(args.projectId);
    },
    /** Mirrors `set_counted` in skill_manager.rs: the name is validated, a name the view doesn't list (or a missing
     * skill being turned off) is refused, and so is a skill whose identity couldn't be resolved; turning a missing
     * skill on in All projects clears its global and every project switch. */
    set(args: { name: string; enabled: boolean; projectId?: string }): SkillInventory {
      validateName(args.name);
      const skill = inventory(args.projectId).skills.find(skill => skill.name === args.name);
      if (!skill || (skill.missing && !args.enabled)) fail(NO_LONGER_INSTALLED);
      if (skill?.switchable === false) fail(UNRESOLVED_IDENTITY);
      // Like native: turning a no-longer-installed skill on in All projects clears every switch left for it.
      if (skill?.missing && !args.projectId) {
        offEverywhere = toggle(offEverywhere, args.name, true);
        offByProject = Object.fromEntries(Object.entries(offByProject).map(([id, set]) => [id, toggle(set, args.name, true)]).filter(([, set]) => (set as ReadonlySet<string>).size));
      } else if (args.projectId) offByProject = { ...offByProject, [args.projectId]: toggle(offByProject[args.projectId] ?? new Set(), args.name, args.enabled) };
      else offEverywhere = toggle(offEverywhere, args.name, args.enabled);
      return inventory(args.projectId);
    },
    /** Preview and spec helper: the skill's folders changed on disk since the page listed them (`null`: uninstalled). */
    changeOnDisk(name: string, patch: Partial<Fixture> | null): void {
      fixtures = patch ? fixtures.map(f => f.name === name ? { ...f, ...patch } : f) : fixtures.filter(f => f.name !== name);
    },
    /** Mirrors `skill_manager_restore`: moves a quarantined skill, or every quarantined copy of the name, back;
     * `projectId` only selects the returned view. */
    restore(args: { name: string; projectId?: string }): SkillInventory {
      const flagged = fixtures.find(f => f.name === args.name && f.quarantined);
      if (!flagged) throw new Error(`${args.name} isn’t quarantined.`);
      fixtures = fixtures.map(({ flags, ...f }) => f.name === args.name && f.quarantined ? { ...f, quarantined: false } : { ...f, ...(flags ? { flags } : {}) });
      return inventory(args.projectId);
    },
    /** Mirrors `skill_manager_uninstall`: no `projectId` moves the user-level copies aside, a project only its own
     * copies; when no copy is left in that view the skill's switches are cleared too. Undo puts everything back. */
    uninstall(args: { name: string; projectId?: string }): SkillInventory & { uninstalled: Uninstalled } {
      validateName(args.name);
      const row = inventory(args.projectId).skills.find(s => s.name === args.name && !s.missing && s.agents.length);
      if (!row) fail('This skill is no longer installed. Refresh the skill list and try again.');
      const here = (agent: SkillAgent, f: Fixture) => !agent.quarantined && (args.projectId ? agent.scope === 'project' && (agent.projectId ?? f.project) === args.projectId : agent.scope === 'user');
      const removed = fixtures.filter(f => f.name === args.name).flatMap(f => f.agents.filter(a => here(a, f)).map(a => a.path));
      if (!removed.length) fail('PandaCode found no copy of this skill it can remove here.');
      const id = `uninstall-${++uninstalls}`;
      const records = [...undos, [id, { name: args.name, fixtures, offEverywhere, offByProject }] as const];
      const expired = records.slice(0, Math.max(0, records.length - (options.undoLimit ?? Infinity)));
      undos = new Map(records.slice(expired.length));
      fixtures = fixtures.map(f => f.name === args.name ? { ...f, agents: f.agents.filter(a => !here(a, f)) } : f).filter(f => f.missing || f.agents.length);
      const switchesCleared = !inventory(args.projectId).skills.some(s => s.name === args.name && s.agents.length);
      if (switchesCleared) {
        if (args.projectId) offByProject = { ...offByProject, [args.projectId]: toggle(offByProject[args.projectId] ?? new Set(), args.name, true) };
        else offEverywhere = toggle(offEverywhere, args.name, true);
      }
      const expiredUndo = expired.length ? { expiredUndo: expired.map(([, r]) => r.name), expiredUndoIds: expired.map(([key]) => key) } : {};
      return { ...inventory(args.projectId), uninstalled: { id, name: args.name, removed, kept: [], switchesCleared, ...expiredUndo } };
    },
    /** Mirrors `skill_manager_undo_uninstall`: once per uninstall; `projectId` only selects the returned view. */
    undoUninstall(args: { id: string; projectId?: string }): SkillInventory {
      const saved = undos.get(args.id);
      if (!saved) fail('This uninstall can no longer be undone.');
      ({ fixtures, offEverywhere, offByProject } = saved!);
      undos = new Map([...undos].filter(([key]) => key !== args.id));
      return inventory(args.projectId);
    },
    async preview(args: { source: string }): Promise<SkillPreview> {
      await wait();
      const { source, selected } = parseSource(args.source);
      const skills = libraryPreview(source) ?? CATALOG[catalogKey(source)];
      if (!skills) throw new Error(`The skills CLI found no skills at ${source}. Check the owner/repo and try again.`);
      return selected ? { source, skills, selected } : { source, skills };
    },
    /** Mirrors `skill_manager_add_library`: stages, scans and imports clean skills into the library for bots; flagged
     * skills are reported and not imported; agents' folders (this inventory) never change. Rejects only when
     * nothing was imported or flagged. */
    async addLibrary(args: { source: string; skills: string[] }): Promise<LibraryAdd> {
      await wait();
      if (!args.skills?.length) fail('Choose at least one skill to add.');
      args.skills.forEach(validateName);
      const offered = libraryPreview(args.source) ?? CATALOG[normalize(args.source)] ?? [];
      const flagged = new Set((options.findings ?? []).map(f => f.skill));
      const findings = (options.findings ?? []).filter(f => args.skills.includes(f.skill));
      const clean = args.skills.filter(name => !flagged.has(name)).map(name => offered.find(s => s.name === name) ?? { name, description: '' });
      const { imported, failures } = library.importSkills(recordedSource(args.source), clean);
      if (!imported.length && !findings.length) fail(failures[0]?.reason ?? 'No skills were added to the library.');
      return { imported, findings, failures };
    },
    async add(args: { source: string; skills: string[]; harnesses: string[]; projectId?: string }): Promise<SkillInventory> {
      await wait();
      if (!args.harnesses.length) throw new Error('Choose at least one agent to install skills for.');
      args.skills.forEach(validateName);
      const make = args.projectId ? project : user;
      const created = new Set<string>();
      for (const name of args.skills) {
        const existing = fixtures.find(f => f.name === name && f.project === args.projectId);
        const agents = args.harnesses.filter(h => !existing?.agents.some(a => a.harness === h)).map(h => ({ ...make(h, name), ...(args.projectId ? { projectId: args.projectId } : {}) }));
        if (existing) fixtures = fixtures.map(f => f === existing ? { ...f, agents: [...f.agents, ...agents] } : f);
        else {
          created.add(name);
          fixtures = [...fixtures, {
            name, switchable: true, description: CATALOG[normalize(args.source)]?.find(s => s.name === name)?.description ?? '', source: recordedSource(args.source),
            project: args.projectId, agents,
          }];
        }
      }
      // Like native (install.rs `switch_scope`): folders this add created are quarantined; a skill it only updated
      // is switched off where the add went, in that project for a project add, else in All projects.
      const flagged = options.installError ? [] : (options.findings ?? []).map(f => f.skill);
      fixtures = fixtures.map(f => flagged.includes(f.name) && created.has(f.name) ? { ...f, quarantined: true, ...flagsFor(f.name, options.findings) } : f);
      // `switchedOff`: only the names whose switch in that scope this add turned off (already off: not listed).
      const scope = args.projectId;
      const switchedOff: string[] = [];
      for (const name of flagged.filter(n => args.skills.includes(n) && !created.has(n))) {
        const was = scope ? offByProject[scope] ?? new Set<string>() : offEverywhere;
        if (!was.has(name)) switchedOff.push(name);
        if (scope) offByProject = { ...offByProject, [scope]: toggle(was, name, false) };
        else offEverywhere = toggle(offEverywhere, name, false);
      }
      const findings = (options.findings ?? []).map(f => flagged.includes(f.skill) && created.has(f.skill) ? { ...f, quarantined: true } : f);
      return { ...inventory(args.projectId), findings, failures: [], ...(switchedOff.length ? { switchedOff } : {}), ...(options.installError ? { error: options.installError } : {}) };
    },
  };
}
