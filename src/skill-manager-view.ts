/* Skill manager markup: one template helper per piece, all pure (state in, HTML out). */
import { escape, icon } from './dom';
import { providerLogo } from './provider-logos';
import { appMissingText, askedWhenOffText, canUninstall, enforcementLabel, heldOff, flagLabel, flagPlace, flagsOf, harnessName, harnessesOf, isLocked, isOff, listText, loadingAgents, hasQuarantine, scopeLabel, skillDomId as domId, type ManagedSkill, type SkillAgent, type SkillFinding, type SkillFindingDetail, type SkillHarness } from './skill-manager-model';
import type { ProviderId } from './types';

export type ScopeOption = { id: string; name: string };
/** A quarantined skill's Restore: asking for confirmation, or waiting for native. */
export type RestoreState = Readonly<{ name: string; phase: 'confirm' | 'saving' }> | null;
/** A skill's Uninstall: asking for confirmation, or waiting for native. */
export type UninstallState = RestoreState;
export type RowState = {
  projectId: string; projectName: string; expanded: ReadonlySet<string>; errors: Readonly<Record<string, string>>; saving: ReadonlySet<string>;
  projects: readonly ScopeOption[]; harnesses: readonly SkillHarness[]; restore?: RestoreState; uninstall?: UninstallState;
  /** The last add's findings: why a skill quarantined before native saved `flags` was flagged. */
  findings?: readonly SkillFinding[];
};
/** Findings listed in a quarantined row's details before '+N more'. */
const MAX_FLAGS = 3;
/** Harness chips shown before a '+N' chip. */
const MAX_CHIPS = 4;
const MAX_PROJECT_CHIPS = 2;

let scopeLabels = 0;
/** The scope picker, labelled 'Show skills for' so it never reads as a second tab row: small separate pills for
 * up to three options (a radio group: arrow keys move), else a compact select styled as a field. */
export function scopeHtml(options: readonly ScopeOption[], selected: string): string {
  if (options.length < 2) return '';
  const labelId = `skill-scope-label-${++scopeLabels}`;
  if (options.length <= 3) {
    const buttons = options.map(o => `<button type="button" role="radio" data-scope="${escape(o.id)}" aria-checked="${o.id === selected}" tabindex="${o.id === selected ? 0 : -1}">${escape(o.name)}</button>`).join('');
    return `<div class="skill-manager-scope-field"><span class="skill-manager-scope-label" id="${labelId}">Show skills for</span><div class="skill-manager-scope" role="radiogroup" aria-labelledby="${labelId}">${buttons}</div></div>`;
  }
  const items = options.map(o => `<option value="${escape(o.id)}"${o.id === selected ? ' selected' : ''}>${escape(o.name)}</option>`).join('');
  return `<label class="skill-manager-scope-field"><span class="skill-manager-scope-label">Show skills for</span><select class="settings-select skill-manager-scope-select">${items}</select></label>`;
}

export function toolbarHtml(scope: string): string {
  // Search and Add travel together: when the bar is too narrow they wrap as one line under the scope.
  // The info mark beside the scope says where switches act (in PandaCode, for the scope picked) and what they reach.
  return `<div class="skill-manager-bar"><span class="skill-manager-scope-slot">${scope}</span><span class="skill-manager-info" data-sm-enforcement hidden></span>
    <div class="skill-manager-find"><label class="skill-manager-search">${icon('search')}<input type="search" aria-label="Search skills" placeholder="Search skills" autocomplete="off" spellcheck="false" maxlength="200"></label>
    <button type="button" class="ds-btn-primary" data-sm-add>${icon('plus')}Add skill</button></div></div>`;
}

/** A harness chip: its logo, plus its name when the whole list shows names (skill-manager.ts decides per view, never
 * per row). The label is its accessible name and tooltip. An agent app missing on this computer names itself without
 * hovering, at any width and whatever data-names says: a dashed chip with its name over
 * 'missing' and no logo (CSS hides it; the tooltip and accessible name say 'Kimi Code app missing'), never 'not installed', which would read as if the
 * skill weren't. */
const CHIP_MISSING = 'missing';
const chip = (label: string, content: string, missing = false, name = '') =>
  `<span class="ds-chip skill-chip"${missing ? ' data-missing' : ''} role="img" aria-label="${escape(label)}" data-tip="${escape(label)}">${content}${name ? `<span class="skill-chip-name">${escape(name)}</span>` : ''}${missing ? `<span class="skill-chip-missing">${CHIP_MISSING}</span>` : ''}</span>`;

/** Installed in the project being viewed (not only in agents' home folders). */
export const inProject = (skill: ManagedSkill, projectId: string): boolean =>
  !!projectId && loadingAgents(skill).some(agent => agent.scope === 'project' && (agent.projectId ?? projectId) === projectId);
const projectChip = (label: string, tip: string, aria = '') =>
  `<span class="ds-chip ds-chip-text skill-chip-project" data-tip="${escape(tip)}"${aria ? ` aria-label="${escape(aria)}"` : ''}>${icon('folder')}<span>${escape(label)}</span></span>`;

function chipsHtml(skill: ManagedSkill, state: RowState): string {
  const { projectId, projects } = state;
  const ids = harnessesOf(skill), names = ids.map(harnessName);
  const missing = new Set(state.harnesses.filter(h => !h.installed).map(h => h.id));
  const fits = ids.length <= MAX_CHIPS ? ids.length : MAX_CHIPS - 1;
  const logos = ids.slice(0, fits).map((id, i) => missing.has(id) ? chip(appMissingText(id), providerLogo(id as ProviderId), true, names[i]) : chip(names[i], providerLogo(id as ProviderId), false, names[i]));
  const more = ids.length > fits ? [chip(`Also ${listText(names.slice(fits))}`, `+${ids.length - fits}`)] : [];
  // All projects names the projects a skill lives in; a project view marks the skills that belong to it. A skill
  // also installed in agents' home folders is 'Also installed in orbit', never 'only'.
  const labels = projectId ? [] : [...new Set(loadingAgents(skill).filter(a => a.projectId).map(a => projects.find(p => p.id === a.projectId)?.name ?? 'Project'))];
  const installed = loadingAgents(skill).some(a => a.scope === 'user') ? 'Also installed' : 'Installed';
  const project = inProject(skill, projectId) ? [projectChip('This project', `${installed} in ${state.projectName || 'this project'}`)]
    : labels.slice(0, MAX_PROJECT_CHIPS).map(label => projectChip(label, `${installed} in ${label}`));
  if (labels.length > MAX_PROJECT_CHIPS) project.push(projectChip(`+${labels.length - MAX_PROJECT_CHIPS}`, `${installed} in ${listText(labels)}`, labels.join(', ')));
  return `<span class="skill-row-tags">${[...project, ...logos, ...more].join('')}</span>`;
}

/** A calm state marker in the row's metadata: quarantined, a quarantined copy beside a clean install (both short;
 * why is in the tooltip and the details), or no longer installed. Every tag in the meta line ('Off in all projects',
 * 'Off in orbit', these) shares one look: .skill-row-tag. */
function stateTag(skill: ManagedSkill): string {
  if (skill.quarantined) return `<span class="skill-row-tag skill-row-state" data-state="quarantined" data-tip="Moved aside after the safety check flagged it. Open for details.">${icon('shield')}<span>Quarantined</span></span>`;
  if (skill.quarantinedCopy) return `<span class="skill-row-tag skill-row-state" data-state="quarantined" data-tip="The safety check flagged another copy of this skill and PandaCode moved that copy aside. Open for details.">${icon('shield')}<span>Copy quarantined</span></span>`;
  if (skill.missing) return `<span class="skill-row-tag skill-row-state" data-state="missing" data-tip="${MISSING_TIP}"><span>Not installed</span></span>`;
  return '';
}
const MISSING_TIP = 'Switched off, but no longer installed. Clear removes the leftover setting.';

/** A 'Not installed' row's one action: clear the leftover setting (native drops the row). Locked rows get 'Manage'. */
function clearButton(skill: ManagedSkill, state: RowState): string {
  const busy = state.saving.has(skill.name);
  if (!skill.missing || isLocked(skill, state.projectId) || (!busy && !heldOff(skill, state.projectId))) return '';
  return `<button type="button" class="skill-row-change" data-sm-forget aria-label="${escape(`Clear the setting for ${skill.name}`)}"${busy ? ' disabled' : ''}>${busy ? 'Clearing…' : 'Clear'}</button>`;
}

function metaHtml(skill: ManagedSkill, state: RowState): string {
  const offNames = (skill.offInProjects ?? []).map(id => state.projects.find(p => p.id === id)?.name ?? id);
  // All projects names the projects holding it off; a project view says when All projects holds it off (locked),
  // with a short link right after it that opens All projects on this skill. The meta line sits outside the
  // disclosure button, so the link is a real button and no row gives up width for it.
  const locked = !skill.quarantined && isLocked(skill, state.projectId);
  const manage = locked ? `<button type="button" class="skill-row-change" data-sm-unlock aria-label="${MANAGE_LINK}">Manage</button>` : '';
  // Quarantined, or a quarantined copy beside a clean install: Restore is one short link after the tag, like Manage.
  const restore = hasQuarantine(skill) ? restoreButton(skill, state) : '';
  // A no-longer-installed row keeps 'Off in orbit' in All projects, so it shows who holds the setting Clear removes.
  const offTag = skill.quarantined || (skill.missing && state.projectId) ? ''
    : locked ? `<span class="skill-row-tag skill-chip-off" data-locked id="${domId(skill.name)}-lock">${icon('lock')}<span>Off in all projects</span></span>`
    : !state.projectId && offNames.length ? `<span class="skill-row-tag skill-chip-off" data-tip="${escape(offNames.join(', '))}"><span>Off in ${offNames.length === 1 ? escape(offNames[0]) : `${offNames.length} projects`}</span></span>` : '';
  const tag = stateTag(skill), clear = clearButton(skill, state);
  return tag || offTag || manage ? `<span class="ds-row-meta skill-row-meta">${tag}${restore}${clear}${offTag}${manage}</span>` : '';
}

const UNSWITCHABLE = 'This skill’s name does not support switching it off.';
/** A locked row's 'Manage' link, by its accessible name: the switch that holds it off lives in All projects. */
export const MANAGE_LINK = 'Manage in All projects';

/** Restore for a quarantined skill or its quarantined copy: a link in the meta line, the same for both, in the
 * warning tone with an alert glyph (any accent, even a yellow one, tells it apart) and an ellipsis (it asks first),
 * so it never reads like a locked row's plain 'Manage'. */
function restoreButton(skill: ManagedSkill, state: RowState): string {
  const saving = state.restore?.name === skill.name && state.restore.phase === 'saving';
  const label = skill.quarantined ? `Restore ${skill.name}…` : `Restore the quarantined copy of ${skill.name}…`;
  return `<button type="button" class="skill-row-change" data-sm-restore aria-label="${escape(label)}"${state.restore?.name === skill.name ? ' disabled' : ''}>${saving ? 'Restoring…' : `${icon('alert')}Restore…`}</button>`;
}

function switchHtml(skill: ManagedSkill, state: RowState): string {
  // A quarantined skill has no switch (it can't load anywhere; its Restore is in the meta line), nor has a skill no
  // longer installed (its Clear is there). An empty slot as wide as a switch keeps chips in line with other rows'.
  if (skill.quarantined || skill.missing) return '<span class="skill-row-controls" aria-hidden="true"><span class="skill-row-no-switch"></span></span>';
  const where = scopeLabel(state.projectName), off = isOff(skill, state.projectId);
  const locked = isLocked(skill, state.projectId);
  // A locked switch is described by the meta line's 'Off in all projects' (its 'Manage' link sits beside it).
  const hint = skill.switchable === false ? `<span class="skill-row-hint" aria-hidden="true">${icon('lock')}</span>` : '';
  // Off doesn't hold for every agent here: one quiet 'May still load' tag beside the switch says so. It takes
  // keyboard focus, so its tooltip (which agents, and why) opens from the keyboard too; it also describes the switch.
  const asked = mayStillLoadHtml(skill, state);
  const busy = state.saving.has(skill.name) ? ' aria-busy="true"' : '';
  const described = [locked ? `${domId(skill.name)}-lock` : '', asked ? `${domId(skill.name)}-asked` : ''].filter(Boolean).join(' ');
  const disabled = skill.switchable === false ? ` disabled data-tip="${escape(skill.unswitchableReason || UNSWITCHABLE)}"`
    : locked ? ' disabled data-locked' : '';
  return `<span class="skill-row-controls">${hint}${asked}<input${described && skill.switchable !== false ? ` aria-describedby="${described}"` : ''} type="checkbox" role="switch" class="ds-toggle" data-sm-toggle aria-label="${escape(`${skill.name} in ${where}`)}"${off ? '' : ' checked'}${busy}${disabled}></span>`;
}

/** The 'May still load' tag's words for this row ('' when off holds everywhere, or the row is on). */
const mayStillLoad = (skill: ManagedSkill, state: RowState): string => skill.missing ? '' : askedWhenOffText(skill, state.harnesses, state.projectId);
function mayStillLoadHtml(skill: ManagedSkill, state: RowState): string {
  const why = mayStillLoad(skill, state);
  return why ? `<span class="skill-row-asked" id="${domId(skill.name)}-asked" tabindex="0" role="img" aria-label="${escape(`May still load. ${why}`)}" data-tip="${escape(why)}">May still load</span>` : '';
}

/** A path that wraps after its slashes rather than mid-name. */
const pathHtml = (path: string): string => escape(path).replace(/([/\\])/g, '$1<wbr>');

/** One install location: harness, scope and what the harness does with an off skill, or a separate
 * 'App missing' marker when the agent app is missing on this computer. A quarantined skill, or a quarantined copy's
 * location, can't load, so it says only where it was ('Quarantined'). */
function agentHtml(agent: SkillAgent, state: RowState, skill: ManagedSkill): string {
  const scope = agent.scope === 'project' ? state.projects.find(p => p.id === agent.projectId)?.name ?? 'Project' : 'User';
  const harness = state.harnesses.find(h => h.id === agent.harness);
  const missing = !!harness && !harness.installed, inert = !!skill.quarantined || !!agent.quarantined;
  const enforcement = inert ? '' : enforcementLabel(state.harnesses, agent.harness, skill);
  const marker = agent.quarantined ? ' <span class="skill-detail-missing">Quarantined</span>' : missing ? ' <span class="skill-detail-missing">App missing</span>' : '';
  // Native's caveat about this harness's consoles (Claude-family: typed /commands still run there), on a line of
  // its own under the location so the label column stays narrow.
  const note = !inert && harness?.installed && harness.consoleNote ? `<small class="skill-detail-note">${escape(harness.consoleNote)}</small>` : '';
  return `<li><span class="skill-detail-harness"><span class="skill-detail-name">${escape(harnessName(agent.harness))}</span><small>${escape(enforcement ? `${scope} · ${enforcement}` : scope)}${marker}</small></span><code>${pathHtml(agent.path)}</code>${note}</li>`;
}

function detailsNote(skill: ManagedSkill, state: RowState): string {
  if (skill.quarantined) return 'The safety check flagged this skill, so PandaCode moved it aside. Agents can’t load it until you restore it.';
  if (skill.quarantinedCopy) return 'The safety check flagged another copy of this skill, so PandaCode moved that copy aside. Its switch works for the other copies.';
  if (skill.missing) return `This skill is switched off but no longer installed. ${isLocked(skill, state.projectId) ? 'Its setting is in All projects (Manage).' : 'Clear removes the leftover setting.'}`;
  return skill.switchable === false ? skill.unswitchableReason || UNSWITCHABLE : '';
}

/** One finding on one line: what the check saw, where, and its redacted excerpt (ellipsized; whole in the tooltip).
 * Add skill's result lists flagged skills' findings the same way. */
export const flagHtml = (flag: SkillFindingDetail, tag: 'li' | 'span' = 'li'): string =>
  `<${tag} class="skill-flag"><span class="skill-flag-rule">${escape(flagLabel(flag.rule))}</span><code class="skill-flag-place">${escape(flagPlace(flag))}</code>${flag.excerpt ? `<code class="skill-flag-excerpt" data-tip="${escape(flag.excerpt)}">${escape(flag.excerpt)}</code>` : ''}</${tag}>`;

/** Why a quarantined skill was flagged, compact: the first few findings, then '+N more'. */
function flagsHtml(skill: ManagedSkill, state: RowState): string {
  const flags = hasQuarantine(skill) ? flagsOf(skill, state) : [];
  if (!flags.length) return '';
  const more = flags.length > MAX_FLAGS ? `<li class="skill-flag-more">+${flags.length - MAX_FLAGS} more</li>` : '';
  return `<ul class="skill-flags" aria-label="Why it was flagged">${flags.slice(0, MAX_FLAGS).map(flag => flagHtml(flag)).join('')}${more}</ul>`;
}

/** A row's details: what the skill does, then (quarantined) the plain reason and the flagged files, then where it is
 * installed; the source is its own short line under the locations, with Uninstall… at its right end. The restore question follows the details. */
function detailsHtml(skill: ManagedSkill, state: RowState): string {
  const source = skill.source ? `<code>${pathHtml(skill.source)}</code>` : 'Installed locally';
  const note = detailsNote(skill, state);
  const agents = skill.agents.length ? `<div class="skill-detail-table"><ul class="skill-detail-agents" aria-label="Installed for">${skill.agents.map(agent => agentHtml(agent, state, skill)).join('')}</ul></div>` : '';
  return `<div class="skill-row-details" id="${domId(skill.name)}-details">
    ${skill.description ? `<p class="skill-detail-description">${escape(skill.description)}</p>` : ''}${note ? `<p class="skill-detail-reason">${escape(note)}</p>` : ''}${flagsHtml(skill, state)}
    ${agents}<p class="skill-detail-source"><span>Source</span>${source}${uninstallLinkHtml(skill, state)}</p></div>`;
}

/** Uninstall is quiet: one link at the right end of the open details' Source line, for a skill with a copy to remove in this view. */
function uninstallLinkHtml(skill: ManagedSkill, state: RowState): string {
  if (!canUninstall(skill, state.projectId)) return '';
  const busy = state.uninstall?.name === skill.name;
  return `<span class="skill-detail-actions"><button type="button" class="skill-row-change" data-sm-uninstall aria-label="${escape(`Uninstall ${skill.name}…`)}"${busy ? ' disabled' : ''}>${busy && state.uninstall?.phase === 'saving' ? 'Uninstalling…' : 'Uninstall…'}</button></span>`;
}

/** Uninstall asks first, naming the scope: 'from orbit' removes that project's copies, 'from all projects' the
 * user-level ones. Undo follows on the page line. */
function uninstallConfirmHtml(skill: ManagedSkill, state: RowState): string {
  if (state.uninstall?.name !== skill.name || state.uninstall.phase !== 'confirm') return '';
  const where = scopeLabel(state.projectName);
  const copies = state.projectId ? 'this project’s copies' : 'the copies in your home folder';
  return `<div class="skill-row-confirm" role="group" aria-label="${escape(`Uninstall ${skill.name} from ${where}`)}"><div class="skill-row-confirm-text"><p>Uninstall ${escape(skill.name)} from ${escape(where)}? PandaCode moves ${copies} aside; you can undo it.</p></div>
    <span class="skill-row-confirm-actions"><button type="button" class="ds-btn" data-sm-uninstall-cancel>Cancel</button><button type="button" class="ds-btn ds-danger" data-sm-uninstall-confirm>Uninstall</button></span></div>`;
}

/** Restore asks first: it puts flagged files back where agents load them. Unless the open details already say why,
 * the question names what was found, compactly: the first finding (rule, place, redacted excerpt) and how many
 * more, or, with none saved, that the safety check flagged it. */
function restoreConfirmHtml(skill: ManagedSkill, state: RowState): string {
  if (state.restore?.name !== skill.name || state.restore.phase !== 'confirm') return '';
  const open = state.expanded.has(skill.name);
  const flags = open ? [] : flagsOf(skill, state), first = flags[0];
  const why = first ? `<span class="skill-row-confirm-why">${flagHtml(first, 'span')}${flags.length > 1 ? `<span class="skill-flag-more">${escape(`+${flags.length - 1} more`)}</span>` : ''}</span>` : '';
  const flagged = open || first ? '' : ' The safety check flagged it.';
  const what = skill.quarantined ? skill.name : `the quarantined copy of ${skill.name}`;
  return `<div class="skill-row-confirm" role="group" aria-label="${escape(`Restore ${what}`)}"><div class="skill-row-confirm-text"><p>Restore ${escape(what)}?${flagged} Agents can load it again in new tasks.</p>${why}</div>
    <span class="skill-row-confirm-actions"><button type="button" class="ds-btn" data-sm-restore-cancel>Cancel</button><button type="button" class="ds-btn ds-danger" data-sm-restore-confirm>Restore anyway</button></span></div>`;
}

/** The row carries a tag beside its chips (a project chip, or 'May still load'): its chips stay logos only, so the
 * title and description keep most of the row (CSS; skill-manager.ts leaves such rows out of the list-wide fit). */
const hasTag = (skill: ManagedSkill, state: RowState): boolean =>
  !!mayStillLoad(skill, state) || (state.projectId ? inProject(skill, state.projectId) : loadingAgents(skill).some(a => a.projectId));

export function rowHtml(skill: ManagedSkill, state: RowState): string {
  const open = state.expanded.has(skill.name), error = state.errors[skill.name];
  const off = isOff(skill, state.projectId) || !!skill.quarantined;
  return `<li class="skill-row${off ? ' is-off' : ''}" data-id="${escape(skill.name)}"${hasTag(skill, state) ? ' data-compact' : ''}${open ? ' data-open' : ''}${skill.quarantined ? ' data-quarantined' : ''}${skill.quarantinedCopy ? ' data-quarantined-copy' : ''}${skill.missing ? ' data-missing' : ''}>
    <div class="ds-row"><div class="skill-row-lead"><button type="button" class="skill-row-body" data-sm-expand aria-expanded="${open}" aria-controls="${domId(skill.name)}-details">
      ${icon('chevron')}<span class="ds-row-main"><span class="ds-row-title">${escape(skill.name)}</span>${open ? '' : `<span class="ds-row-sub">${escape(skill.description || (skill.missing ? 'Switched off, but no longer installed.' : 'No description'))}</span>`}</span>
    </button>${metaHtml(skill, state)}</div>${chipsHtml(skill, state)}${switchHtml(skill, state)}</div>
    ${open ? detailsHtml(skill, state) : ''}${restoreConfirmHtml(skill, state)}${uninstallConfirmHtml(skill, state)}${error ? `<p class="skill-row-error ds-danger" role="alert">${escape(error)}</p>` : ''}</li>`;
}

export const listHtml = (rows: string): string => `<ul class="skill-manager-list" aria-label="Skills">${rows}</ul>`;

export function skeletonHtml(count = 4): string {
  const row = '<li class="skill-row skill-row-skeleton"><div class="ds-row"><span class="ds-row-main"><span class="skeleton-bar"></span><span class="skeleton-bar skeleton-bar-short"></span></span><span class="skeleton-switch"></span></div></li>';
  return `<ul class="skill-manager-list" aria-hidden="true">${row.repeat(count)}</ul>`;
}

export function emptyHtml(): string {
  return `<div class="skill-manager-empty"><strong>No skills installed yet</strong><span>Skills teach agents how to do specific tasks.</span>
    <button type="button" class="ds-btn" data-sm-add>${icon('plus')}Add skill</button></div>`;
}

export function noResultsHtml(query: string): string {
  return `<div class="skill-manager-empty"><strong>No skills match “${escape(query.trim())}”</strong>
    <button type="button" class="ds-btn" data-sm-clear>Clear search</button></div>`;
}

export function loadErrorHtml(message: string): string {
  return `<div class="skill-manager-empty"><strong>Couldn’t load skills</strong><span class="ds-danger" role="alert">${escape(message)}</span>
    <button type="button" class="ds-btn" data-sm-retry>${icon('refresh')}Try again</button></div>`;
}
