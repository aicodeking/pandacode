/* Skill manager: the IPC contract (src-tauri/src/skill_manager.rs) and pure helpers over it.
 * Nothing here touches the DOM, so the page and the Add skill dialog share it. */

import { errorText as sharedErrorText } from './error-text.ts';

/** `quarantined`: a location of a row's quarantined copy (see `quarantinedCopy`); it loads nowhere. */
export type SkillAgent = { harness: string; scope: 'user' | 'project'; path: string; projectId?: string; quarantined?: true };
/** `quarantined`: flagged by the safety check and moved aside until restored (`skill_manager_restore`); the row has
 * no clean install. `quarantinedCopy`: the row has a clean install (its switch works as usual) and also a
 * quarantined copy, whose locations are in `agents` marked `quarantined`; Restore moves every copy back.
 * `missing`: switched off but no longer installed; its switch can only clear the setting. All optional. */
export type ManagedSkill = {
  name: string; description: string; agents: SkillAgent[]; offInPandaCode: boolean; offInProject: boolean; offInProjects: string[]; source: string | null;
  switchable?: boolean; unswitchableReason?: string; enforcementOverrides?: Readonly<Record<string, SkillModes>>;
  quarantined?: boolean; quarantinedCopy?: boolean; missing?: boolean;
  /** Why a quarantined skill (or its quarantined copy) was flagged: the safety findings saved with it (at most 20,
   * excerpts redacted). Records quarantined by older builds have none; see `flagsOf`. */
  flags?: SkillFindingDetail[];
};
/** How a harness honours a switched-off skill: `blocked` won't load it (agents can still read its files), `asked` is told not to use it, `none` can't be told. */
export type SkillEnforcement = 'blocked' | 'asked' | 'none';
/** A harness's modes for tasks PandaCode starts and for its terminal consoles. */
export type SkillModes = { enforcement: SkillEnforcement; consoleEnforcement: SkillEnforcement };
/** `enforcement` and `consoleEnforcement` come from native's one enforcement table (skill_manager/matrix.rs).
 * Per-skill `enforcementOverrides` replace both for that skill; see `modesOf`. `consoleNote`: an optional caveat
 * about the harness's consoles (Claude-family: typed /commands still run), shown in a row's details. */
export type SkillHarness = {
  id: string; installed: boolean; enforcement: SkillEnforcement; consoleEnforcement: SkillEnforcement; consoleNote?: string;
  installable: boolean; installAs?: string;
};
/** `notShown`: a lower bound on project or skill folders the bounded scan skipped (not a skill count); absent when none. */
/** `prefsWarning`: names native kept off because they no longer pass validation (a calm notice). `prefsError`: the
 * switch settings couldn't be read. `prefsLost`: with `prefsError`, nothing readable was left, so every skill is off
 * until the user resets (otherwise the last saved switches apply). `linksWarning`: native's note about skill links it
 * couldn't follow or put back (a calm notice, nothing to do here). */
export type SkillInventory = { projectId: string | null; harnesses: SkillHarness[]; skills: ManagedSkill[]; notShown?: number; failures?: { skill: string; reason: string }[]; findings?: SkillFinding[]; switchedOff?: string[]; prefsError?: string; prefsLost?: boolean; prefsWarning?: string; linksWarning?: string; error?: string };
/** `skill_manager_uninstall`'s report (beside the flattened inventory): `id` goes to `skill_manager_undo_uninstall`;
 * `removed` and `kept` are display paths (`kept`: copies left in place, ones PandaCode didn't put there, and shared
 * ancestor copies ending in native's reason, ' (in a folder above this project, shared with the projects under it)');
 * `switchesCleared`: no copy was left in that view, so the skill's switches were cleared (Undo sets them again);
 * `expiredUndo`: names of earlier uninstalls whose Undo records were dropped to keep the file small (absent when none). */
export type Uninstalled = { id: string; name: string; removed?: string[]; kept?: string[]; switchesCleared?: boolean; expiredUndo?: string[]; expiredUndoIds?: string[] };
export type UninstallResult = SkillInventory & { uninstalled: Uninstalled };
/** The skill has a copy uninstall can move aside in this view: user-level copies in All projects, the project's own
 * copies in a project. Quarantined copies are Restore's, so they don't count. */
export const canUninstall = (skill: ManagedSkill, projectId: string): boolean => !skill.quarantined && !skill.missing &&
  skill.agents.some(a => !a.quarantined && (projectId ? a.scope === 'project' && a.projectId === projectId : a.scope === 'user'));
/** A `kept` entry that carries native's own reason, '<path> (in a folder above this project, shared with …)'. */
const KEPT_REASON = /\s\([^()]+\)$/;
/** The page line after an uninstall: where from, and any copies left in place: ones PandaCode didn't install, then
 * ones native explains itself (shared ancestor folders), each with its reason. */
export function uninstalledText(result: Uninstalled, where: string): string {
  const kept = result.kept ?? [];
  const plain = kept.filter(entry => !KEPT_REASON.test(entry)), reasoned = kept.filter(entry => KEPT_REASON.test(entry));
  const notOurs = plain.length ? ` Left ${plain.length === 1 ? 'a copy' : `${plain.length} copies`} PandaCode didn’t install in place: ${plain.join(', ')}.` : '';
  const shared = reasoned.length ? ` Left in place: ${reasoned.join(', ')}.` : '';
  return `Uninstalled ${result.name} from ${where}.${notOurs}${shared}`;
}
/** Names listed in the expired-undo note before '+N more'. */
const MAX_EXPIRED_NAMES = 3;
/** The quiet note under the uninstall line when native dropped older Undo records ('' when none). */
export function expiredUndoText(result: Pick<Uninstalled, 'expiredUndo'>): string {
  const names = [...new Set((result.expiredUndo ?? []).filter(name => typeof name === 'string' && name))];
  if (!names.length) return '';
  const shown = names.length > MAX_EXPIRED_NAMES ? [...names.slice(0, MAX_EXPIRED_NAMES - 1), `${names.length - MAX_EXPIRED_NAMES + 1} more`] : names;
  return `Older uninstalls can no longer be undone (${listText(shown)}).`;
}
/** `quarantined`: add moved the folders it created for this skill aside; `skill_manager_restore` brings them back. */
export type SkillFindingDetail = { rule: 'secret' | 'approvals' | 'pipe-to-shell' | 'scan-limit'; file: string; line: number; excerpt: string };
export type SkillFinding = SkillFindingDetail & { skill: string; quarantined?: boolean };
/** `skill_manager_add_library`'s answer: skills imported into PandaCode's library, for bots only (no agent folder
 * changes). Flagged skills are not imported (`findings`); `failures` covers the rest, such as a library item that
 * already exists from another source. */
export type LibraryAdd = { imported: { id: string; name: string }[]; findings: SkillFinding[]; failures: { skill: string; reason: string }[] };
/** Add skill's 'Install to' value for the bot library (never a project id). */
export const BOT_LIBRARY = '@bot-library';
/** The page note after a bot library add. */
export function libraryNote(result: LibraryAdd): string {
  const count = result.imported.length;
  return count ? `Added ${plural(count, 'skill')} to the bot library.` : 'No skills were added to the bot library.';
}
/** One skill a source offers. `switchable: false`: its name can't be switched off later, so Add shows it disabled
 * with native's `unswitchableReason` and never installs it. */
export type PreviewSkill = { name: string; description: string; switchable?: boolean; unswitchableReason?: string };
/** `selected`: the skill a skills.sh link named (native normalizes the link to owner/repo); preselect only those.
 * `source` is owner/repo, a GitHub/GitLab URL, or an absolute local folder path. */
export type SkillPreview = { source: string; skills: PreviewSkill[]; selected?: string[] };
export type SkillManagerHost = {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  projects?(): { id: string; name: string }[];
  /** The project of the thread Settings was opened from ('' or absent: none); the page opens on it. */
  activeProject?(): string;
  /** A folder picker for Add's 'Choose folder…' (defaults to the app's native dialog; null when cancelled). */
  chooseFolder?(): Promise<string | null>;
};

/** Whether Add's source is a folder on this computer: an absolute path ('/…', 'C:\\…', '\\\\server\\…') rather than a
 * repository. Native resolves it and echoes the canonical path as the preview's `source`; add sends that back. */
export const isLocalSource = (source: string): boolean => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(source.trim());
/** A preview skill Add can install: one whose name can be switched off later. */
export const installable = (skill: PreviewSkill): boolean => skill.switchable !== false;

/** Dispatched on window after a switch or install changes skills, so Rules & library can re-read them. */
export const SKILLS_CHANGED_EVENT = 'pandacode:skill-manager-changed';
/** Dispatched on window when Rules & library asks the Skills page to open Add skill. */
export const ADD_SKILL_EVENT = 'pandacode:skill-manager-add';
/** What Rules & library asked Add skill to open with: `source` (a catalog repository or a library skill's folder)
 * is prefilled and looked at right away; '' opens an empty dialog. */
export type AddSkillRequest = Readonly<{ source: string }>;
let addRequested: AddSkillRequest | null = null;
/** Asks the Skills page to open Add skill: at once when it is mounted, else when it next mounts (Settings mounts a
 * page the first time it is shown, which happens after the link's own click handler). */
export function requestAddSkill(source = ''): void {
  addRequested = { source: source.trim() };
  window.dispatchEvent(new CustomEvent(ADD_SKILL_EVENT));
}
/** Claims a pending Add request (once per request); null when there is none. */
export function takeAddSkillRequest(): AddSkillRequest | null {
  const pending = addRequested;
  addRequested = null;
  return pending;
}

const HARNESS_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude Code', codex: 'Codex', kimi: 'Kimi Code', opencode: 'OpenCode', glm: 'GLM', antigravity: 'Antigravity',
  grok: 'Grok Build', mimo: 'MiMo', alibaba: 'Alibaba', pi: 'Pi', deepseek: 'DeepSeek', commandcode: 'Command Code', cline: 'Cline', kilo: 'Kilo Code',
  omp: 'Oh My Pi', 'github-copilot': 'GitHub Copilot', muse: 'Muse Code', devin: 'Devin', zcode: 'ZCode', hermes: 'Hermes',
};
export const harnessName = (id: string): string => HARNESS_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** A readable message from whatever the IPC layer rejected with. */
export const errorText = (error: unknown): string => sharedErrorText(error, 'Something went wrong. Try again.');

/** Off for the scope being viewed: PandaCode-wide always counts; a project adds its own list. */
export const isOff = (skill: ManagedSkill, projectId: string): boolean => skill.offInPandaCode || (!!projectId && skill.offInProject);
/** A switch in this view still holds the skill off; in All projects that includes any project's own switch, since
 * clearing there clears every project's too (what a no-longer-installed row's Clear removes). */
export const heldOff = (skill: ManagedSkill, projectId: string): boolean => isOff(skill, projectId) || (!projectId && (skill.offInProjects ?? []).length > 0);
/** In the project view a skill switched off everywhere can't be turned on per project. */
export const isLocked = (skill: ManagedSkill, projectId: string): boolean => !!projectId && skill.offInPandaCode;
/** Locations that load: a quarantined copy's locations (`agent.quarantined`) don't. */
export const loadingAgents = (skill: ManagedSkill): SkillAgent[] => skill.agents.filter(agent => !agent.quarantined);
/** Harnesses using the skill (its quarantined copy's locations aside): its chips and its 'may still load' count. */
export const harnessesOf = (skill: ManagedSkill): string[] => [...new Set(loadingAgents(skill).map(agent => agent.harness))];
/** A row with something to restore: quarantined, or holding a quarantined copy beside its clean install. */
export const hasQuarantine = (skill: ManagedSkill): boolean => !!skill.quarantined || !!skill.quarantinedCopy;

/** A copy of `inventory` with one skill's switch for the scope set to `off`. */
export function withSkillOff(inventory: SkillInventory, name: string, projectId: string, off: boolean): SkillInventory {
  const field = projectId ? 'offInProject' : 'offInPandaCode';
  return { ...inventory, skills: inventory.skills.map(skill => skill.name === name ? { ...skill, [field]: off, ...(projectId ? { offInProjects: off ? [...new Set([...skill.offInProjects, projectId])] : skill.offInProjects.filter(id => id !== projectId) } : {}) } : skill) };
}

export function matches(skill: ManagedSkill, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${skill.name} ${skill.description}`.toLowerCase();
  return words.every(word => text.includes(word));
}

/** Where a switch applies: 'all projects' for all projects, else the project's name. */
export const scopeLabel = (projectName: string): string => projectName || 'all projects';

/** '10 skills · 1 off in all projects', '12 skills · 2 off in all projects (1 may still load) · 1 off in orbit' (a
 * project counts skills off via All projects apart from its own switches; 'may still load' counts the off skills some
 * installed agent can't be stopped from loading, in tasks or in its console, so the count never overstates 'off'),
 * or '2 of 10 skills' while searching. A setting left for a skill no longer installed (`missing`) is neither a skill
 * nor an off one, so it counts nowhere. */
export function summaryText(skills: readonly ManagedSkill[], projectId: string, projectName: string, shown?: number, searching = false, harnesses: readonly SkillHarness[] = []): string {
  const installed = skills.filter(skill => !skill.missing);
  if (searching) return `${shown ?? installed.length} of ${plural(installed.length, 'skill')}`;
  const part = (off: readonly ManagedSkill[], where: string): string[] => {
    if (!off.length) return [];
    const loose = off.filter(skill => mayStillLoadText(skill, harnesses)).length;
    return [`${off.length} off in ${where}${loose ? ` (${loose} may still load)` : ''}`];
  };
  const everywhere = installed.filter(skill => skill.offInPandaCode);
  const here = projectId ? installed.filter(skill => !skill.offInPandaCode && skill.offInProject) : [];
  return [plural(installed.length, 'skill'), ...part(everywhere, 'all projects'), ...part(here, scopeLabel(projectName))].join(' · ');
}

/** 'A', 'A and B', 'A, B and C'. */
export function listText(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The modes native reports for one skill in one harness: its override when present, else the harness's own.
 * Nothing is derived from names here; a payload missing a mode never claims more than 'asked'. */
export function modesOf(harness: SkillHarness, skill?: Pick<ManagedSkill, 'enforcementOverrides'>): SkillModes {
  const override = skill?.enforcementOverrides?.[harness.id];
  if (override) return override;
  const enforcement = harness.enforcement ?? 'asked';
  return { enforcement, consoleEnforcement: harness.consoleEnforcement ?? enforcement };
}

const ENFORCEMENT_LABELS: Readonly<Record<SkillEnforcement, string>> = { blocked: 'Won’t load when off', asked: 'Asked when off', none: 'Not enforced when off' };
/** What happens in one harness when the skill is off, for a row's details: 'Won’t load when off', 'Asked when off',
 * 'Not enforced when off' (plus the console's, when it differs); '' for a harness missing on this computer
 * (the details show a separate 'App missing' marker) or one PandaCode doesn't list. */
export function enforcementLabel(harnesses: readonly SkillHarness[], id: string, skill?: Pick<ManagedSkill, 'enforcementOverrides'>): string {
  const harness = harnesses.find(h => h.id === id);
  if (!harness?.installed) return '';
  const { enforcement, consoleEnforcement } = modesOf(harness, skill);
  return consoleEnforcement !== enforcement ? `${ENFORCEMENT_LABELS[enforcement]} · console: ${ENFORCEMENT_LABELS[consoleEnforcement].toLowerCase()}` : ENFORCEMENT_LABELS[enforcement];
}

/** Installed agents using this skill whose modes match `test` (none for a quarantined or no-longer-installed skill). */
function agentsWhere(skill: ManagedSkill, harnesses: readonly SkillHarness[], test: (modes: SkillModes) => boolean): string[] {
  if (skill.quarantined || skill.missing) return [];
  const ids = harnessesOf(skill);
  return harnesses.filter(h => h.installed && ids.includes(h.id) && test(modesOf(h, skill))).map(h => harnessName(h.id));
}

/** Why an off skill may still load, in plain words naming the agents ('Pi can only be asked not to use it. In its
 * console, Kimi Code isn’t told to skip it.'); '' when every installed agent using it won't load it, in tasks
 * and in PandaCode's consoles. Off or not: the caller decides when it applies. */
export function mayStillLoadText(skill: ManagedSkill, harnesses: readonly SkillHarness[]): string {
  const asked = agentsWhere(skill, harnesses, m => m.enforcement === 'asked');
  const untold = agentsWhere(skill, harnesses, m => m.enforcement === 'none');
  const consoleUntold = agentsWhere(skill, harnesses, m => m.enforcement !== 'none' && m.consoleEnforcement === 'none');
  const consoleAsked = agentsWhere(skill, harnesses, m => m.enforcement === 'blocked' && m.consoleEnforcement === 'asked');
  const be = (names: readonly string[]) => names.length === 1 ? 'isn’t' : 'aren’t';
  const their = (names: readonly string[]) => names.length === 1 ? 'its console' : 'their consoles';
  return [
    asked.length ? `${listText(asked)} can only be asked not to use it.` : '',
    untold.length ? `${listText(untold)} ${be(untold)} told to skip it.` : '',
    consoleUntold.length ? `In ${their(consoleUntold)}, ${listText(consoleUntold)} ${be(consoleUntold)} told to skip it.` : '',
    consoleAsked.length ? `In ${their(consoleAsked)}, ${listText(consoleAsked)} can only be asked not to use it.` : '',
  ].filter(Boolean).join(' ');
}

/** The 'May still load' tag's tooltip beside an off switch ('' when on, or when off holds everywhere). */
export function askedWhenOffText(skill: ManagedSkill, harnesses: readonly SkillHarness[], projectId: string): string {
  return isOff(skill, projectId) ? mayStillLoadText(skill, harnesses) : '';
}

/** Plain names for safety rules (the same words as Rules & library's FINDING_LABELS, plus scan-limit). */
const FLAG_LABELS: Readonly<Record<SkillFindingDetail['rule'], string>> = {
  secret: 'Secret-shaped value', approvals: 'Turns off approvals or the sandbox', 'pipe-to-shell': 'Download piped into a shell', 'scan-limit': 'Safety scan incomplete',
};
export const flagLabel = (rule: string): string => FLAG_LABELS[rule as SkillFindingDetail['rule']] ?? 'Flagged by the safety check';
/** Where a finding is: 'SKILL.md:12', or just the file when native has no line. */
export const flagPlace = (flag: Pick<SkillFindingDetail, 'file' | 'line'>): string => flag.line > 0 ? `${flag.file}:${flag.line}` : flag.file;

/** Why a quarantined skill was flagged: its own `flags`, else the findings an add just returned for it. */
export function flagsOf(skill: Pick<ManagedSkill, 'name' | 'flags'>, inventory?: { findings?: readonly SkillFinding[] } | null): readonly SkillFindingDetail[] {
  if (skill.flags?.length) return skill.flags;
  return (inventory?.findings ?? []).filter(f => f.skill === skill.name).map(({ rule, file, line, excerpt }) => ({ rule, file, line, excerpt }));
}

/** A DOM id prefix unique per skill name: the readable part is sanitized, so a hash of the full name keeps
 * 'a b', 'a_b' and 'a:b' apart. */
export function skillDomId(name: string): string {
  let hash = 0x811c9dc5;
  for (const ch of name) hash = Math.imul(hash ^ ch.codePointAt(0)!, 0x01000193);
  return `skill-${name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}-${(hash >>> 0).toString(36)}`;
}

/** On the summary line once a switch changes: native reads the switches at every turn. */
export const APPLIES_NOTE = 'Applies from the next turn';

/** What a chip, the details and Add say for an agent app that isn't on this computer ('Kimi Code app missing'):
 * never 'not installed', which reads as if the skill weren't. */
export const APP_MISSING = 'app missing';
export const appMissingText = (id: string): string => `${harnessName(id)} ${APP_MISSING}`;

/** The prefs-error card's first line: native says whether anything readable was left (`prefsLost`). */
export const prefsErrorText = (inventory: Pick<SkillInventory, 'prefsLost'>): string =>
  inventory.prefsLost ? 'All skills are off until you reset.' : 'Using the last saved switches until you reset.';

/** The calm notices under the toolbar: names kept off (only while the settings are readable; the error card speaks
 * otherwise) and native's links note. */
export const noticeLines = (inventory: Pick<SkillInventory, 'prefsError' | 'prefsWarning' | 'linksWarning'> | null): string[] =>
  [inventory?.prefsError ? '' : inventory?.prefsWarning ?? '', inventory?.linksWarning ?? ''].map(line => line.trim()).filter(Boolean);

/** The info tooltip beside the scope picker: where a switch acts, what it reaches, and what it leaves alone. */
export const enforcementNote = (): string => 'Switches apply in PandaCode, for the scope picked here. Agents PandaCode runs follow them from the next turn; files stay installed.';

/** Harness ids whose agent app this inventory reports missing on this computer. */
export const missingHarnesses = (harnesses: readonly SkillHarness[]): ReadonlySet<string> => new Set(harnesses.filter(h => !h.installed).map(h => h.id));

/** '3+ folders not shown' when the bounded scan skipped folders (`notShown` is a lower bound); '' otherwise. */
export const notShownText = (inventory: Pick<SkillInventory, 'notShown'>): string => {
  const count = Math.floor(inventory.notShown ?? 0);
  return Number.isFinite(count) && count > 0 ? `${count}+ ${count === 1 ? 'folder' : 'folders'} not shown` : '';
};

/** Skills an add flagged, by what PandaCode did: moved aside (`quarantined`) or switched off where it went (`off`). */
export function flaggedNames(findings: readonly SkillFinding[] = []): Readonly<{ quarantined: readonly string[]; off: readonly string[] }> {
  const names = [...new Set(findings.map(f => f.skill))];
  const quarantined = names.filter(name => findings.some(f => f.skill === name && f.quarantined));
  return { quarantined, off: names.filter(name => !quarantined.includes(name)) };
}
/** The page note after an install, never counting a flagged skill as installed: 'Installed 2 skills for Claude Code
 * · 1 skill off for review.', '1 skill quarantined for review.' `clean`: skills installed and not flagged. */
export function addedNote(clean: number, harnesses: readonly string[], findings: readonly SkillFinding[] = []): string {
  const { quarantined, off } = flaggedNames(findings);
  const parts = [
    clean ? `Installed ${plural(clean, 'skill')}${harnesses.length ? ` for ${listText(harnesses)}` : ''}` : '',
    quarantined.length ? `${plural(quarantined.length, 'skill')} quarantined` : '',
    off.length ? `${plural(off.length, 'skill')} off` : '',
  ].filter(Boolean);
  if (!parts.length) return 'Already installed.';
  return `${parts.join(' · ')}${quarantined.length || off.length ? ' for review' : ''}.`;
}
/** The page note after an install: compare each harness, scope, project and displayed location. */
export function installNote(before: SkillInventory, after: SkillInventory): string {
  const location = (name: string, agent: SkillAgent) => JSON.stringify([name, agent.harness, agent.scope, agent.projectId ?? '', agent.path]);
  const had = new Set(before.skills.flatMap(skill => skill.agents.map(agent => location(skill.name, agent))));
  const flagged = new Set((after.findings ?? []).map(f => f.skill));
  const gained = after.skills.filter(skill => !flagged.has(skill.name) && !skill.quarantined)
    .map(skill => ({ name: skill.name, harnesses: loadingAgents(skill).filter(agent => !had.has(location(skill.name, agent))).map(agent => agent.harness) })).filter(skill => skill.harnesses.length);
  const harnesses = [...new Set(gained.flatMap(skill => skill.harnesses))].map(harnessName);
  return addedNote(gained.length, harnesses, after.findings);
}

/** Whether `inventory` lists the install locations for target `projectId` ('' = agents' home folders): the
 * All projects view lists every project's, a project view only its own and the home folders. */
export const coversTarget = (inventory: Pick<SkillInventory, 'projectId'>, projectId: string): boolean =>
  !projectId || !inventory.projectId || inventory.projectId === projectId;

/** What a flagged add did to `name`, from native's answer alone (never a list read before the add): `quarantined`
 * (moved aside; Restore anyway), `unconfirmed` (the add failed, so nothing is claimed), `switched` (listed in
 * `switchedOff`: the add itself switched it off, so 'Turn on anyway' undoes that switch) or `stayed` (already off
 * there; the add switched nothing). */
export type FlaggedOutcome = 'quarantined' | 'unconfirmed' | 'switched' | 'stayed';
export function flaggedOutcome(after: Pick<SkillInventory, 'findings' | 'switchedOff' | 'error'>, name: string): FlaggedOutcome {
  if (flaggedNames(after.findings).quarantined.includes(name)) return 'quarantined';
  // switchedOff is native's own record of switches it set, so it holds even when the add also returned an error.
  if ((after.switchedOff ?? []).includes(name)) return 'switched';
  return after.error ? 'unconfirmed' : 'stayed';
}

/** Skills already installed at target `projectId` ('' = agents' home folders) for every chosen CLI agent id
 * (`installAs`), so Add can mark them. Quarantined and no-longer-installed skills (and quarantined copies) don't count. */
export function installedNames(inventory: SkillInventory, projectId: string, agentIds: readonly string[]): ReadonlySet<string> {
  if (!agentIds.length) return new Set();
  const groupOf = new Map(inventory.harnesses.map(h => [h.id, h.installAs ?? '']));
  const here = (agent: SkillAgent) => projectId ? agent.scope === 'project' && (agent.projectId ?? inventory.projectId) === projectId : agent.scope === 'user';
  return new Set(inventory.skills
    .filter(skill => !skill.missing && !skill.quarantined && agentIds.every(id => loadingAgents(skill).some(agent => here(agent) && groupOf.get(agent.harness) === id)))
    .map(skill => skill.name));
}

/** Harnesses the skills CLI can install for, in roster order, installed on this computer or not (Add checks only
 * the installed ones by default). */
export const installTargets = (harnesses: readonly SkillHarness[]): (SkillHarness & { installAs: string })[] => harnesses.filter((h): h is SkillHarness & { installAs: string } => h.installable && !!h.installAs);
