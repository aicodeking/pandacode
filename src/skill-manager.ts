/* Settings → Tools → Skills: every skill installed for any harness, for all projects or one project, with
 * one switch per row. Native side: src-tauri/src/skill_manager.rs (docs/skill-manager.md). */
import './skill-manager.css';
import { escape, icon, isImeKey, morph } from './dom';
import { openAddSkill } from './skill-manager-add';
import { chooseFolder } from './bridge';
import { ADD_SKILL_EVENT, APPLIES_NOTE, expiredUndoText, uninstalledText, type UninstallResult, enforcementNote, errorText, isLocked, isOff, matches, noticeLines, notShownText, prefsErrorText, scopeLabel, SKILLS_CHANGED_EVENT, summaryText, takeAddSkillRequest, withSkillOff, type SkillInventory, type SkillManagerHost } from './skill-manager-model';
import { infoMark } from './tooltip';
import { emptyHtml, inProject, listHtml, loadErrorHtml, noResultsHtml, rowHtml, scopeHtml, skeletonHtml, toolbarHtml, type RestoreState, type ScopeOption, type UninstallState } from './skill-manager-view';

export type { ManagedSkill, SkillAgent, SkillInventory } from './skill-manager-model';
const announceChange = () => window.dispatchEvent(new CustomEvent(SKILLS_CHANGED_EVENT));

type State = Readonly<{
  /** `failedScope`: the scope whose read failed (`loadError`); the picker stays on the scope shown. */
  inventory: SkillInventory | null; loading: boolean; loadError: string; failedScope: string; query: string; projectId: string;
  expanded: ReadonlySet<string>; saving: ReadonlySet<string>; errors: Readonly<Record<string, string>>; note: string; reset: 'idle' | 'confirm' | 'saving'; resetError: string;
  /** A switch changed since the page opened: show that switches apply from the next turn. */
  switched: boolean; restore: RestoreState; uninstall: UninstallState;
  /** The last uninstall, offered for Undo until the next change: its id and what the line says. Undo answers with
   * the view shown then (native puts the files back wherever they were). */
  undo: Readonly<{ id: string; name: string; text: string; expired: string; saving: boolean; error: string }> | null;
  /** A switch save that failed after the page moved to another scope: its row isn't shown, so the floating line
   * says which skill and where, until the next change or Dismiss. */
  saveError: string;
}>;
const INITIAL: State = { inventory: null, loading: true, loadError: '', failedScope: '', query: '', projectId: '', expanded: new Set(), saving: new Set(), errors: {}, note: '', reset: 'idle', resetError: '', switched: false, restore: null, uninstall: null, undo: null, saveError: '' };
const ALL_PROJECTS: ScopeOption = { id: '', name: 'All projects' };
/** Agent names on chips need a list at least this wide (px; Settings at 1200px gives about 700)… */
const NAMES_MIN_LIST_PX = 680;
/** …no row naming more agents than this (more chips keep every row to logos)… */
const NAMES_MAX_CHIPS = 2;
/** …and never leave a row's title and description narrower than this (px, padding included)… */
const MIN_LEAD_PX = 300;
/** …nor less than this share of the row: descriptions say more than agent names. */
const MIN_LEAD_SHARE = 0.6;
/** The floating Undo line's distance from the scroller's bottom edge (px; `bottom` in skill-manager.css). */
const FLOAT_OFFSET_PX = 12;

/** The nearest ancestor that scrolls vertically (Settings' content pane), else the document. */
function scrollerOf(element: HTMLElement): HTMLElement {
  for (let el = element.parentElement; el && el !== document.body; el = el.parentElement) {
    if (/^(auto|scroll)$/.test(getComputedStyle(el).overflowY)) return el;
  }
  return document.documentElement;
}

const withItem = (set: ReadonlySet<string>, item: string, on: boolean): ReadonlySet<string> => {
  const next = new Set(set);
  if (on) next.add(item); else next.delete(item);
  return next;
};
const withError = (errors: State['errors'], name: string, message: string): State['errors'] => {
  const { [name]: _, ...rest } = errors;
  return message ? { ...rest, [name]: message } : rest;
};
/** The scope the loaded list belongs to: while another scope loads, the old list stays (dimmed). */
const shownScope = (state: State): string => state.inventory?.projectId ?? '';
/** The list on screen belongs to another scope, or its own refresh failed: it stays, dimmed and inert, until a read
 * lands. (A failed read of another scope leaves the picker on the list shown, which stays usable.) */
const isStale = (state: State): boolean => !!state.inventory && (shownScope(state) !== state.projectId || (!!state.loadError && state.failedScope === shownScope(state)));

/** Unreadable switch settings: title and Reset on one line, what applies meanwhile with native's detail under it;
 * Reset asks first. */
function warningHtml(inventory: SkillInventory, reset: State['reset'], resetError: string): string {
  const confirm = reset === 'idle' ? '' : `<p>Turns every skill back on in all projects and clears project switches.</p><span class="skill-manager-reset-actions"><button type="button" class="ds-btn" data-sm-reset-cancel${reset === 'saving' ? ' disabled' : ''}>Cancel</button><button type="button" class="ds-btn-primary" data-sm-reset-confirm${reset === 'saving' ? ' disabled' : ''}>${reset === 'saving' ? 'Resetting…' : 'Turn every skill back on'}</button></span>`;
  return `<div class="skill-manager-warning-head"><span class="ds-warn skill-manager-warning-icon">${icon('alert')}</span><strong>Couldn’t read skill settings</strong>${reset === 'idle' ? '<button type="button" class="ds-btn" data-sm-reset>Reset switches</button>' : ''}</div>
    <div class="skill-manager-warning-body"><p>${escape(prefsErrorText(inventory))} <span class="skill-manager-warning-detail">${escape(inventory.prefsError ?? '')}</span></p>${confirm}
    ${resetError ? `<p class="ds-danger" role="alert">Couldn’t reset switches: ${escape(resetError)}</p>` : ''}</div>`;
}

export function mountSkillManager(host: HTMLElement, options: SkillManagerHost): () => void {
  let scopes: ScopeOption[] = [ALL_PROJECTS, ...(options.projects?.() ?? [])];
  // Opened from a project's thread: start on that project (when the picker offers it), else All projects.
  const active = options.activeProject?.() ?? '';
  const initialScope = active && scopes.some(s => s.id === active) ? active : '';
  // One quiet line (count, notes, and once a switch changed 'Applies from the next turn'); where switches act and how
  // they are enforced lives in the info mark beside the scope picker and each row's details. Nothing a switch or
  // an uninstall writes moves the rows: the applies note shares the summary line (shown whole or not at all), and
  // Undo floats at the bottom of the view (sticky, after the list), never above it. Whatever needs saying above the
  // list (unreadable settings, a failed read, native's calm lines) shares one compact area, so the list starts near
  // the top however many speak at once.
  host.innerHTML = `<div class="skill-manager">${toolbarHtml(scopeHtml(scopes, initialScope))}
    <div class="skill-manager-notices" data-sm-notices hidden><div class="skill-manager-warning" data-sm-warning role="status" hidden></div><div class="skill-manager-load-error" data-sm-load-error role="alert" hidden></div><div class="skill-manager-notice" data-sm-notice role="status" hidden></div></div>
    <div class="skill-manager-head"><p class="skill-manager-summary" aria-hidden="true"></p><span class="skill-manager-applies-slot"><span class="skill-manager-applies" role="status" data-tip="${APPLIES_NOTE}" hidden></span></span><span class="sr-only" data-sm-live role="status"></span></div>
    <div class="ds-card skill-manager-card"><div class="ds-card-inner skill-manager-body"></div></div>
    <div class="skill-manager-float" data-sm-float hidden><p class="skill-manager-undo" data-sm-undone role="status" hidden></p><p class="skill-manager-save-error" data-sm-save-error role="alert" hidden></p></div></div>`;
  const root = host.querySelector<HTMLElement>('.skill-manager')!;
  const search = root.querySelector<HTMLInputElement>('input[type=search]')!;
  const summary = root.querySelector<HTMLElement>('.skill-manager-summary')!;
  const body = root.querySelector<HTMLElement>('.skill-manager-body')!;
  const warning = root.querySelector<HTMLElement>('[data-sm-warning]')!;
  const info = root.querySelector<HTMLElement>('[data-sm-enforcement]')!;
  const notice = root.querySelector<HTMLElement>('[data-sm-notice]')!;
  const notices = root.querySelector<HTMLElement>('[data-sm-notices]')!;
  const undone = root.querySelector<HTMLElement>('[data-sm-undone]')!;
  const float = root.querySelector<HTMLElement>('[data-sm-float]')!;
  const saveError = root.querySelector<HTMLElement>('[data-sm-save-error]')!;
  const loadError = root.querySelector<HTMLElement>('[data-sm-load-error]')!;
  const applies = root.querySelector<HTMLElement>('.skill-manager-applies')!;
  const slot = root.querySelector<HTMLElement>('.skill-manager-scope-slot')!;
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  const live = root.querySelector<HTMLElement>('[data-sm-live]')!;
  let state: State = { ...INITIAL, projectId: initialScope }, revision = 0, disposed = false, focusAfterLoad = '';
  /** Saves run in order; confirmed values and pending intent are tracked separately. */
  let saves: Promise<void> = Promise.resolve();
  const confirmed = new Map<string, boolean>();
  const intents = new Map<string, boolean>();
  let savingCount: Readonly<Record<string, number>> = {};
  const countSave = (name: string, delta: number): ReadonlySet<string> => {
    savingCount = { ...savingCount, [name]: (savingCount[name] ?? 0) + delta };
    return new Set(Object.keys(savingCount).filter(key => savingCount[key] > 0));
  };

  const segment = () => slot.querySelector<HTMLElement>('.skill-manager-scope');
  /** Switches the user flipped that are still saving, re-applied over any inventory native returns meanwhile. */
  const withIntents = (inventory: SkillInventory, projectId: string): SkillInventory => [...intents]
    .filter(([key]) => key.startsWith(`${projectId}\n`) && (savingCount[key.slice(projectId.length + 1)] ?? 0) > 0)
    .reduce((next, [key, off]) => withSkillOff(next, key.slice(projectId.length + 1), projectId, off), inventory);
  const projectName = (projectId: string) => scopes.find(s => s.id === projectId && s.id)?.name ?? '';
  /** Records native's switch values for a scope. */
  const remember = (inventory: SkillInventory, projectId: string, keep: (name: string) => boolean = () => true) => inventory.skills
    .filter(skill => keep(skill.name)).forEach(skill => confirmed.set(`${projectId}\n${skill.name}`, isOff(skill, projectId)));

  /** Redraws the scope picker when the project list changed (a project added while Settings was open). */
  function drawScope(): void {
    const next = [ALL_PROJECTS, ...(options.projects?.() ?? [])];
    if (next.map(s => `${s.id}\n${s.name}`).join('\n') === scopes.map(s => `${s.id}\n${s.name}`).join('\n')) return;
    scopes = next;
    if (!scopes.some(s => s.id === state.projectId)) state = { ...state, projectId: '' };
    slot.innerHTML = scopeHtml(scopes, state.projectId);
  }

  function bodyHtml(): string {
    if (state.loading && !state.inventory) return skeletonHtml();
    if (state.loadError && !state.inventory) return loadErrorHtml(state.loadError);
    const skills = state.inventory?.skills ?? [];
    if (!skills.length) return emptyHtml();
    const scope = shownScope(state);
    // A project view lists the project's own skills first (stable: otherwise native's order).
    const shown = skills.filter(skill => matches(skill, state.query))
      .map((skill, index) => ({ skill, rank: inProject(skill, scope) ? 0 : 1, index }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index).map(entry => entry.skill);
    if (!shown.length) return noResultsHtml(state.query);
    const rowState = { ...state, projectId: scope, projectName: projectName(scope), projects: scopes, harnesses: state.inventory?.harnesses ?? [], restore: state.restore, uninstall: state.uninstall, findings: state.inventory?.findings };
    return listHtml(shown.map(skill => rowHtml(skill, rowState)).join(''));
  }

  function summaryHtml(): string {
    if (!state.inventory) return escape(state.note || (state.loading ? 'Loading skills…' : ''));
    const scope = shownScope(state), skills = state.inventory.skills;
    // Leftover settings (`missing`) aren't skills, so neither count holds them.
    const query = state.query.trim(), shown = skills.filter(skill => !skill.missing && (!query || matches(skill, query))).length;
    const hidden = query ? '' : notShownText(state.inventory);
    const text = `${summaryText(skills, scope, projectName(scope), shown, !!query, state.inventory.harnesses)}${hidden ? ` · ${hidden}` : ''}`;
    return `${escape(text)}${state.note ? ` <span class="skill-manager-note">· ${escape(state.note)}</span>` : ''}`;
  }

  const render = () => {
    if (disposed) return;
    // The live region speaks on every write, so only write when the words change.
    const text = summaryHtml();
    if (summary.innerHTML !== text) {
      summary.innerHTML = text;
      clearTimeout(liveTimer);
      liveTimer = setTimeout(() => { if (!disposed) live.textContent = summary.textContent; }, state.query ? 400 : 0);
    }
    const stale = isStale(state);
    warning.hidden = !state.inventory?.prefsError;
    morph(warning, state.inventory?.prefsError ? warningHtml(state.inventory, state.reset, state.resetError) : '');
    // Calm lines, nothing to do: names native kept off because they no longer pass validation, and its links note.
    const lines = noticeLines(state.inventory);
    notice.hidden = !lines.length;
    morph(notice, lines.map(line => `<p>${escape(line)}</p>`).join(''));
    const undo = state.undo;
    undone.hidden = !undo;
    morph(undone, undo ? `<span class="skill-manager-undo-text">${escape(undo.error ? `Couldn’t undo: ${undo.error}` : undo.text)}</span><button type="button" class="skill-row-change" data-sm-undo aria-label="${escape(`Undo uninstalling ${undo.name}`)}"${undo.saving ? ' disabled' : ''}>${undo.saving ? 'Undoing…' : 'Undo'}</button>${undo.expired ? `<span class="skill-manager-undo-expired">${escape(undo.expired)}</span>` : ''}` : '');
    saveError.hidden = !state.saveError;
    morph(saveError, state.saveError ? `<span class="ds-danger skill-manager-save-error-text">${escape(state.saveError)}</span><button type="button" class="skill-row-change" data-sm-dismiss>Dismiss</button>` : '');
    float.hidden = !undo && !state.saveError;
    reserveFloat();
    // A failed read over a list already shown: say so above the dimmed list, with Retry (outside the inert body).
    const failed = state.loadError && state.inventory ? state.loadError : '';
    loadError.hidden = !failed;
    morph(loadError, failed ? `<span class="ds-danger skill-manager-load-error-icon">${icon('alert')}</span><span class="skill-manager-load-error-text"><strong>Couldn’t load skills for ${escape(scopeLabel(projectName(state.failedScope)))}.</strong> ${escape(failed)}</span><button type="button" class="ds-btn" data-sm-retry>Retry</button>` : '');
    notices.hidden = warning.hidden && notice.hidden && loadError.hidden;
    // A card only around the settings warning; failed reads and calm lines alone stay quiet lines.
    notices.classList.toggle('ds-card', !warning.hidden);
    morph(body, bodyHtml(), 6);
    fitChips();
    body.classList.toggle('is-stale', stale);
    body.toggleAttribute('aria-busy', state.loading);
    body.toggleAttribute('inert', stale || state.reset === 'saving');
    // A switch the user flipped keeps a dirty `checked` property that attributes no longer drive.
    body.querySelectorAll<HTMLInputElement>('[data-sm-toggle]').forEach(input => {
      const skill = state.inventory?.skills.find(s => s.name === input.closest<HTMLElement>('[data-id]')?.dataset.id);
      if (skill) input.checked = !isOff(skill, shownScope(state));
    });
    const note = state.inventory?.skills.length ? enforcementNote() : '';
    // Rewrite only when the words change: the mark may hold keyboard focus.
    if (info.dataset.note !== note) { info.dataset.note = note; info.innerHTML = note ? infoMark(note, 'How switches work') : ''; }
    info.hidden = !note;
    const showApplies = state.switched && !!state.inventory?.skills.length;
    if (showApplies !== !applies.hidden) {
      // On the summary line, whole or not at all (CSS); written once, so the status speaks once.
      applies.textContent = showApplies ? APPLIES_NOTE : '';
      applies.hidden = !showApplies;
    }
    if (focusAfterLoad && !stale && !state.loading) {
      // A switch, or a no-longer-installed row's Clear (it has no switch).
      body.querySelector<HTMLElement>(`[data-id="${CSS.escape(focusAfterLoad)}"] :is([data-sm-toggle], [data-sm-forget])`)?.focus();
      focusAfterLoad = '';
    }
  };
  const update = (patch: Partial<State>) => { state = { ...state, ...patch }; render(); };

  /** Agent names on chips are decided for the whole view, never per row, so rows don't flip between named and
   * logo-only chips. Names show only when the list is at least NAMES_MIN_LIST_PX wide and no row carries more than
   * NAMES_MAX_CHIPS chips, and only if, named, every row's chips still fit their share and leave its title and
   * description at least MIN_LEAD_PX and MIN_LEAD_SHARE of the row; otherwise every row keeps logos, the names in
   * their tooltips and accessible names. Rows with a tag (a project chip, 'May still load') always show logos only
   * (data-compact), so they don't count. Chips align right, so an overflow runs off the left edge, where scrollWidth
   * can't see it: measure the chips' own span. One write, all reads, one write: one layout. */
  function fitChips(): void {
    const groups = [...body.querySelectorAll<HTMLElement>('.skill-row:not([data-compact]) .skill-row-tags')];
    const allowed = groups.length > 0 && body.clientWidth >= NAMES_MIN_LIST_PX && groups.every(tags => tags.childElementCount <= NAMES_MAX_CHIPS);
    body.toggleAttribute('data-names', allowed);
    if (!allowed) return;
    const tight = groups.some(tags => {
      const first = tags.firstElementChild, last = tags.lastElementChild, row = tags.parentElement;
      if (!first || !last || !row || !tags.clientWidth) return false;
      const span = last.getBoundingClientRect().right - first.getBoundingClientRect().left;
      const lead = row.querySelector<HTMLElement>('.skill-row-lead')?.clientWidth ?? Infinity;
      return span > tags.clientWidth + 1 || lead < Math.max(MIN_LEAD_PX, row.clientWidth * MIN_LEAD_SHARE);
    });
    if (tight) body.removeAttribute('data-names');
  }
  // Refit when the list's width changes, a frame later: fitting changes row heights, and doing that inside the
  // observer's callback would resize the observed list mid-delivery (WebKit reports a ResizeObserver loop).
  let fitWidth = -1, fitFrame = 0;
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    if (disposed || body.clientWidth === fitWidth) return;
    fitWidth = body.clientWidth;
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => { if (!disposed) fitChips(); });
  });
  resize?.observe(body);

  /** While Undo (or a save error) floats, the scroller reserves its height plus its offsets at the bottom
   * (scroll-padding), so a row reached by keyboard or scrolled into view stops above it, never under it; the end of
   * the list already rests clear of it (the line sits in flow after the list). Cleared when it hides. */
  let reserved: HTMLElement | null = null;
  function reserveFloat(): void {
    if (float.hidden || disposed) {
      if (reserved) reserved.style.scrollPaddingBottom = '';
      reserved = null;
      return;
    }
    reserved ??= scrollerOf(root);
    reserved.style.scrollPaddingBottom = `${Math.ceil(float.getBoundingClientRect().height) + 2 * FLOAT_OFFSET_PX}px`;
  }
  /** Browsers don't scroll a partly visible control into view on focus (nor honour scroll-padding then): a control
   * that takes focus under the floating line scrolls up just clear of it. */
  const onFocusClear = (event: FocusEvent) => {
    const target = event.target instanceof HTMLElement && body.contains(event.target) ? event.target : null;
    if (!target || float.hidden) return;
    const line = float.getBoundingClientRect(), box = target.getBoundingClientRect();
    if (box.bottom > line.top && box.top < line.bottom) (reserved ?? scrollerOf(root)).scrollBy({ top: box.bottom - line.top + FLOAT_OFFSET_PX });
  };
  const floatResize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => reserveFloat());
  floatResize?.observe(float);

  async function refresh(note = ''): Promise<void> {
    drawScope();
    const ticket = ++revision, projectId = state.projectId;
    update({ loading: true, loadError: '', failedScope: '', note });
    try {
      await saves; // a list read after the queued saves sees them
      const inventory = await options.call<SkillInventory>('skill_manager_list', projectId ? { projectId } : {});
      if (!disposed && ticket === revision) {
        // Switches flipped meanwhile still saving keep their intent (and their confirmed value).
        remember(inventory, projectId, name => (savingCount[name] ?? 0) === 0);
        // Open rows stay open while another scope loads (and if it fails); the new scope's list starts closed.
        const expanded = state.inventory && shownScope(state) === projectId ? state.expanded : new Set<string>();
        update({ inventory: withIntents({ ...inventory, projectId: projectId || null }, projectId), loading: false, errors: {}, expanded });
      }
    } catch (error) {
      if (disposed || ticket !== revision) return;
      // The list already shown stays, with the error and Retry above it; with none, the error takes its place. A
      // failed read of another scope puts the picker back on the scope shown, so picker, caption and list agree.
      const shown = state.inventory ? shownScope(state) : projectId;
      if (shown !== state.projectId) markScope(shown);
      update({ loading: false, loadError: errorText(error), failedScope: projectId, projectId: shown });
    }
  }

  /** Optimistic: the switch moves now; saves go out in order and only the last answer replaces the list. */
  function setSkill(name: string, enabled: boolean): void {
    const inventory = state.inventory, projectId = shownScope(state), skill = inventory?.skills.find(s => s.name === name), where = scopeLabel(projectName(projectId));
    if (!inventory || !skill || skill.switchable === false || isStale(state) || state.reset === 'saving' || isLocked(skill, projectId)) return;
    // A read of this same scope is in flight (it may answer from before this save): it is redone after the save.
    const reread = state.loading;
    const key = `${projectId}\n${name}`;
    intents.set(key, !enabled);
    update({ inventory: withSkillOff(inventory, name, projectId, !enabled), saving: countSave(name, 1), errors: withError(state.errors, name, ''), note: '', switched: true, saveError: '' });
    const save = async () => {
      let next: SkillInventory | null = null, failure = '';
      try {
        next = await options.call<SkillInventory>('skill_manager_set', { name, enabled, ...(projectId ? { projectId } : {}) });
      } catch (error) {
        failure = errorText(error);
      }
      const settled = countSave(name, -1);
      if (next) announceChange();
      const pending = (savingCount[name] ?? 0) > 0;
      if (!pending) intents.delete(key);
      if (disposed) return;
      // The user picked another view since: the row's own error would vanish with its list, so the floating line
      // says which skill failed, and where.
      const elsewhere = state.projectId !== projectId;
      // A 'Not installed' row's Clear is this same save, worded as what the user asked for.
      const what = skill.missing && enabled ? `clear the setting for ${name}` : `turn ${name} ${enabled ? 'on' : 'off'}`;
      const saveError = failure && elsewhere ? { saveError: `Couldn’t ${what} in ${where}: ${failure}` } : {};
      if (shownScope(state) !== projectId || !state.inventory) { update({ saving: settled, ...saveError }); return; }
      if (next) remember(next, projectId, other => !intents.has(`${projectId}\n${other}`) || other === name);
      const message = failure && !elsewhere ? `Couldn’t ${what}: ${failure}` : '';
      // Native's answer is the newest list (new harnesses, notShown, a cleared missing row); switches still
      // saving keep their intent, and a failed save falls back to the last confirmed value.
      const base = next ? withIntents({ ...next, projectId: projectId || null }, projectId) : state.inventory;
      update({ inventory: withSkillOff(base, name, projectId, pending ? intents.get(key)! : confirmed.get(key) ?? isOff(skill, projectId)), saving: settled, errors: withError(state.errors, name, message), ...saveError });
      // A cleared 'Not installed' row leaves the list: keep keyboard focus on the page.
      if (next && !next.skills.some(s => s.name === name) && !root.contains(document.activeElement)) search.focus();
    };
    saves = saves.then(save);
    if (reread) void refresh();
  }

  function resetSwitches(): void {
    if (state.reset !== 'confirm') return;
    const projectId = state.projectId;
    revision++; // Discard reads started before the reset.
    update({ reset: 'saving', resetError: '', loading: true });
    saves = saves.then(async () => {
      try {
        const inventory = await options.call<SkillInventory>('skill_manager_reset', projectId ? { projectId } : {});
        announceChange();
        if (disposed) return;
        confirmed.clear();
        if (state.projectId !== projectId) {
          update({ reset: 'idle' });
          void refresh('Every skill is back on.');
          return;
        }
        remember(inventory, projectId);
        update({ inventory, reset: 'idle', loading: false, errors: {}, note: 'Every skill is back on.' });
        search.focus();
      } catch (error) {
        if (!disposed) update({ reset: 'confirm', resetError: errorText(error), loading: false });
      }
    });
  }

  /** Restores a quarantined skill after the row's confirmation; native answers with a fresh inventory. */
  function restoreSkill(name: string): void {
    if (state.restore?.name !== name || state.restore.phase !== 'confirm') return;
    const projectId = state.projectId;
    update({ restore: { name, phase: 'saving' }, errors: withError(state.errors, name, '') });
    saves = saves.then(async () => {
      try {
        const inventory = await options.call<SkillInventory>('skill_manager_restore', { name, ...(projectId ? { projectId } : {}) });
        announceChange();
        if (disposed) return;
        update({ restore: null });
        if (state.projectId !== projectId || (inventory.projectId ?? '') !== projectId) { void refresh(`Restored ${name}.`); return; }
        revision++; // Discard older reads.
        remember(inventory, projectId);
        update({ inventory: withIntents(inventory, projectId), loading: false, note: `Restored ${name}.` });
        body.querySelector<HTMLElement>(`[data-id="${CSS.escape(name)}"] [data-sm-toggle]`)?.focus();
      } catch (error) {
        if (!disposed) update({ restore: null, errors: withError(state.errors, name, `Couldn’t restore ${name}: ${errorText(error)}`) });
      }
    });
  }

  /** Uninstalls after the row's confirmation: native moves this view's copies aside and answers with the new
   * inventory and an id for Undo, which the page line offers until the next uninstall. */
  function uninstallSkill(name: string): void {
    if (state.uninstall?.name !== name || state.uninstall.phase !== 'confirm') return;
    const projectId = shownScope(state), where = scopeLabel(projectName(projectId));
    update({ uninstall: { name, phase: 'saving' }, errors: withError(state.errors, name, '') });
    saves = saves.then(async () => {
      try {
        const { uninstalled, ...inventory } = await options.call<UninstallResult>('skill_manager_uninstall', { name, ...(projectId ? { projectId } : {}) });
        announceChange();
        if (disposed) return;
        const undo = { id: uninstalled.id, name, text: uninstalledText({ ...uninstalled, name }, where), expired: expiredUndoText(uninstalled), saving: false, error: '' };
        if (state.projectId !== projectId) { update({ uninstall: null, undo, saveError: '' }); void refresh(); return; }
        revision++; // Discard older reads.
        remember(inventory, projectId);
        update({ inventory: withIntents({ ...inventory, projectId: projectId || null }, projectId), loading: false, uninstall: null, undo, saveError: '', expanded: withItem(state.expanded, name, false) });
        // The line floats at the bottom of the view: focusing it never scrolls the list.
        undone.querySelector<HTMLElement>('[data-sm-undo]')?.focus({ preventScroll: true });
      } catch (error) {
        if (!disposed) update({ uninstall: null, errors: withError(state.errors, name, `Couldn’t uninstall ${name}: ${errorText(error)}`) });
      }
    });
  }

  /** Puts the last uninstall back; native answers with the inventory for the view shown. */
  function undoUninstall(): void {
    const undo = state.undo;
    if (!undo || undo.saving) return;
    const projectId = state.projectId;
    update({ undo: { ...undo, saving: true, error: '' } });
    saves = saves.then(async () => {
      try {
        const inventory = await options.call<SkillInventory>('skill_manager_undo_uninstall', { id: undo.id, ...(projectId ? { projectId } : {}) });
        announceChange();
        if (disposed) return;
        update({ undo: null });
        if (state.projectId !== projectId) { void refresh(`Put ${undo.name} back.`); return; }
        revision++;
        remember(inventory, projectId);
        update({ inventory: withIntents({ ...inventory, projectId: projectId || null }, projectId), loading: false, note: `Put ${undo.name} back.` });
        body.querySelector<HTMLElement>(`[data-id="${CSS.escape(undo.name)}"] [data-sm-expand]`)?.focus();
      } catch (error) {
        if (!disposed && state.undo) update({ undo: { ...state.undo, saving: false, error: errorText(error) } });
      }
    });
  }

  /** Moves the picker (pills or select) to `projectId`; keyboard focus inside the pills follows it. */
  function markScope(projectId: string): void {
    const seg = segment(), focused = !!seg?.contains(document.activeElement);
    seg?.querySelectorAll<HTMLElement>('[data-scope]').forEach(b => {
      const on = b.dataset.scope === projectId;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focused) b.focus();
    });
    const select = slot.querySelector<HTMLSelectElement>('select');
    if (select) select.value = projectId;
  }

  const selectScope = (projectId: string) => {
    if (projectId === state.projectId) return;
    markScope(projectId);
    // 'Applies from the next turn' spoke for the switches of the scope left behind.
    state = { ...state, projectId, switched: false, restore: state.restore?.phase === 'saving' ? state.restore : null, uninstall: state.uninstall?.phase === 'saving' ? state.uninstall : null };
    void refresh();
  };

  const openAdd = (source = '') => {
    const scope = state.projectId;
    void openAddSkill({
      source, call: options.call, chooseFolder: options.chooseFolder ?? (() => chooseFolder('Choose a skill folder')), harnesses: state.inventory?.harnesses ?? [], inventory: state.inventory, projects: options.projects?.() ?? [], project: scope ? { id: scope, name: projectName(scope) } : null,
      trigger: () => root.querySelector<HTMLElement>('.skill-manager-bar [data-sm-add]'),
      onProgress: note => { if (!disposed) update({ note }); },
      // The bot library changed (Rules & library and bots read it); the agents' list here did not.
      onLibraryAdded: note => { announceChange(); if (!disposed) update({ note }); },
      onInstalled: (note, inventory) => {
        announceChange();
        if (disposed) return;
        if ((inventory.projectId ?? '') !== state.projectId) { void refresh(note); return; }
        // Add already scanned the installed files. Reuse that inventory and discard older reads.
        revision++;
        remember(inventory, state.projectId);
        update({ inventory, loading: false, loadError: '', errors: {}, note });
      },
    });
  };

  const onClick = (event: MouseEvent) => {
    // The lead's meta line (outside the disclosure button) opens the details too, like the rest of the lead.
    const target = (event.target as Element).closest<HTMLElement>('[data-sm-add],[data-sm-expand],[data-sm-clear],[data-sm-retry],[data-sm-unlock],[data-sm-reset],[data-sm-reset-confirm],[data-sm-reset-cancel],[data-sm-restore],[data-sm-restore-confirm],[data-sm-restore-cancel],[data-sm-uninstall],[data-sm-uninstall-confirm],[data-sm-uninstall-cancel],[data-sm-undo],[data-sm-dismiss],[data-sm-forget],[data-scope],.skill-row-lead');
    if (!target) return;
    const rowName = target.closest<HTMLElement>('[data-id]')?.dataset.id ?? '';
    const rowControl = (selector: string) => body.querySelector<HTMLElement>(`[data-id="${CSS.escape(rowName)}"] ${selector}`);
    if (target.matches('[data-sm-add]')) openAdd();
    else if (target.matches('[data-sm-restore]')) { if (state.restore?.phase !== 'saving') { update({ restore: { name: rowName, phase: 'confirm' } }); rowControl('[data-sm-restore-cancel]')?.focus(); } }
    else if (target.matches('[data-sm-restore-cancel]')) { update({ restore: null }); rowControl('[data-sm-restore]')?.focus(); }
    else if (target.matches('[data-sm-restore-confirm]')) restoreSkill(rowName);
    else if (target.matches('[data-sm-uninstall]')) { if (state.uninstall?.phase !== 'saving') { update({ uninstall: { name: rowName, phase: 'confirm' } }); rowControl('[data-sm-uninstall-cancel]')?.focus(); } }
    else if (target.matches('[data-sm-uninstall-cancel]')) { update({ uninstall: null }); rowControl('[data-sm-uninstall]')?.focus(); }
    else if (target.matches('[data-sm-uninstall-confirm]')) uninstallSkill(rowName);
    else if (target.matches('[data-sm-undo]')) undoUninstall();
    // 'Not installed': Clear turns the leftover switch back on, which drops the setting (and the row).
    else if (target.matches('[data-sm-forget]')) setSkill(rowName, true);
    else if (target.matches('[data-sm-dismiss]')) { update({ saveError: '' }); search.focus(); }
    else if (target.matches('[data-sm-retry]')) { if (state.failedScope !== state.projectId) selectScope(state.failedScope); else void refresh(); }
    else if (target.matches('[data-sm-reset]')) { update({ reset: 'confirm', resetError: '' }); warning.querySelector<HTMLElement>('[data-sm-reset-cancel]')?.focus(); }
    else if (target.matches('[data-sm-reset-cancel]')) { update({ reset: 'idle', resetError: '' }); warning.querySelector<HTMLElement>('[data-sm-reset]')?.focus(); }
    else if (target.matches('[data-sm-reset-confirm]')) resetSwitches();
    else if (target.matches('[data-sm-clear]')) { search.value = ''; update({ query: '' }); search.focus(); }
    else if (target.matches('[data-scope]')) selectScope(target.dataset.scope ?? '');
    else if (target.matches('[data-sm-unlock]')) {
      focusAfterLoad = target.closest<HTMLElement>('[data-id]')?.dataset.id ?? '';
      selectScope('');
    } else {
      if (rowName) update({ expanded: withItem(state.expanded, rowName, !state.expanded.has(rowName)) });
    }
  };
  const onChange = (event: Event) => {
    const input = event.target;
    if (input instanceof HTMLSelectElement && input.matches('.skill-manager-scope-select')) { selectScope(input.value); return; }
    if (!(input instanceof HTMLInputElement) || !input.matches('[data-sm-toggle]')) return;
    const name = input.closest<HTMLElement>('[data-id]')?.dataset.id;
    if (name) setSkill(name, input.checked);
  };
  const onScopeKey = (event: KeyboardEvent) => {
    const seg = segment();
    if (!seg || !seg.contains(event.target as Node)) return;
    const buttons = [...seg.querySelectorAll<HTMLElement>('[data-scope]')];
    const at = buttons.findIndex(b => b.dataset.scope === state.projectId);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : step ? (at + step + buttons.length) % buttons.length : -1;
    if (index < 0) return;
    event.preventDefault();
    buttons[index].focus();
    selectScope(buttons[index].dataset.scope ?? '');
  };
  /** A row title carries its tooltip only while it is cut short; set just before the shared tooltip looks
   * (its document listeners run after this one). */
  const onTitleHint = (event: Event) => {
    const target = event.target instanceof Element ? event.target : null;
    const title = target?.closest('.skill-row-body')?.querySelector<HTMLElement>('.ds-row-title');
    if (!title) return;
    if (title.scrollWidth > title.clientWidth + 1) title.dataset.tip = title.textContent ?? '';
    else title.removeAttribute('data-tip');
  };
  const onSearchInput = () => update({ query: search.value });
  const onSearchKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || isImeKey(event) || !search.value) return;
    event.preventDefault();
    event.stopPropagation();
    search.value = '';
    update({ query: '' });
  };

  // Rules & library asks for the dialog (see requestAddSkill), before or after this mounts, maybe with a source.
  const onAddRequest = () => { const request = takeAddSkillRequest(); if (request) openAdd(request.source); };
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('pointerover', onTitleHint);
  root.addEventListener('focusin', onTitleHint);
  root.addEventListener('focusin', onFocusClear);
  window.addEventListener(ADD_SKILL_EVENT, onAddRequest);
  slot.addEventListener('keydown', onScopeKey);
  search.addEventListener('input', onSearchInput);
  search.addEventListener('keydown', onSearchKey);
  void refresh();
  onAddRequest();
  return () => {
    disposed = true;
    resize?.disconnect();
    floatResize?.disconnect();
    reserveFloat();
    cancelAnimationFrame(fitFrame);
    window.removeEventListener(ADD_SKILL_EVENT, onAddRequest);
    clearTimeout(liveTimer);
    revision++;
    root.removeEventListener('click', onClick);
    root.removeEventListener('change', onChange);
    root.removeEventListener('pointerover', onTitleHint);
    root.removeEventListener('focusin', onTitleHint);
    root.removeEventListener('focusin', onFocusClear);
    slot.removeEventListener('keydown', onScopeKey);
    search.removeEventListener('input', onSearchInput);
    search.removeEventListener('keydown', onSearchKey);
  };
}
