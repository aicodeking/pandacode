import './architect.css';
import { renderTurnChanges, captureChangeCards, restoreChangeCards } from './turn-changes';
import { call } from './bridge';
import { escape, icon, markdown } from './dom';
import { t } from './i18n.ts';
import { providerLogo } from './provider-logos';
import { fallbackModel } from './model-catalog';
import { openModelPicker } from './model-picker';
import { showPopover, hidePopover } from './popover-motion';
import { streamMarkdown } from './streaming-markdown';
import { captureTranscriptAnchor, preserveTranscriptPosition } from './transcript-scroll';
import { bindFileLinkContext, refreshFileLinks, type FileLinkContext } from './file-links';
import { createAgentInput, type AgentInput } from './agent-input';
import { TailText } from './tail-text';
import { decodeToolActivity, renderToolActivity } from './tool-activity';
import { teamActive, type TeamConfig, type TeamSnapshot, type TeamWorker, type ModelSelection, type TeamLibrary, type TeamSetup } from './architect-types';
import { mountTeamProfiles } from './team-profiles';
import { infoMark } from './tooltip';
import { workerQueueReason } from './worker-scheduling';
import { Subagents } from './subagents';
import { TeamMessages } from './team-messages';
import { teamSignature } from './team-progress';
import { renderCoordination } from './coordination-message';
import { bindMessageActions, messageActionsHtml } from './message-actions';
import type { AgentEvent, Message, MessagePage, Provider, ProviderId, ProviderModel, Session, ToolActivity } from './types';
/** The highest round limit a team can have (`MAX_ROUNDS` in architect.rs). */
const MAX_ROUNDS = 20;

type SetupOptions = {
  task: Session; team: TeamSnapshot | null; library: TeamLibrary; providers: Provider[];
  loadModels: (provider: ProviderId) => Promise<ProviderModel[]>;
  save: (config: TeamConfig | null, architect: ModelSelection, profileId: string | null) => Promise<void>;
};
const statusNames: Record<string, string> = { ready: t('Ready'), running: t('Working'), waiting: t('Waiting'), paused: t('Paused'), completed: t('Ready for review'), failed: t('Needs attention'), interrupted: t('Interrupted'), queued: t('Queued'), stopped: t('Stopped'), parked: t('Waiting on sub-workers') };
// Worker rows: a status verb (with its colour tone) and a 28px glyph per state.
const workerVerbs: Record<string, [string, string]> = { running: [t('Working..'), 'accent'], waiting: [t('Waiting'), 'accent'], queued: [t('Queued'), ''], parked: [t('Waiting on sub-workers'), 'accent'], completed: [t('Done'), 'success'], failed: [t('Failed'), 'danger'] };
const ring = (dash: string) => `<circle cx="14" cy="14" r="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="${dash}"/>`;
const workerGlyphs: Record<string, string> = {
  running: `<svg viewBox="0 0 28 28" aria-hidden="true"><g class="architect-glyph-spin">${ring('2.5 4')}</g><circle cx="14" cy="14" r="3.5" fill="currentColor"/></svg>`,
  pending: `<svg viewBox="0 0 28 28" aria-hidden="true">${ring('2.5 4')}<g fill="currentColor"><circle cx="9.5" cy="14" r="1.6"/><circle cx="14" cy="14" r="1.6"/><circle cx="18.5" cy="14" r="1.6"/></g></svg>`,
  completed: `<svg viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="13" fill="currentColor"/><path d="m8.5 14.5 3.6 3.5 7.4-8" fill="none" stroke="var(--panel)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  failed: `<svg viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="13" fill="currentColor"/><path d="M14 7.5v8" stroke="var(--panel)" stroke-width="2.6" stroke-linecap="round"/><circle cx="14" cy="20" r="1.6" fill="var(--panel)"/></svg>`,
  idle: `<svg viewBox="0 0 28 28" aria-hidden="true">${ring('2.5 4')}</svg>`,
};
const modelName = (selection: ModelSelection, providers: Provider[]) => providers.find(p => p.id === selection.provider)?.models.find(m => m.id === selection.model)?.name ?? fallbackModel(selection.provider, selection.model || 'default').name;
const modelMarkup = (selection: ModelSelection, providers: Provider[]) => `<span class="provider-small ${escape(selection.provider)}">${providerLogo(selection.provider)}</span><span>${escape(modelName(selection, providers))}${selection.reasoningEffort ? `<small> · ${escape(selection.reasoningEffort)}</small>` : ''}</span>${icon('down')}`;

type SetupController = (() => void) & { hasChildMenu: () => boolean };

/** A lightweight, anchored editor. The task remains usable without a modal scrim. */
export function openArchitectSetup(anchor: HTMLElement, load: () => Promise<SetupOptions>, onClose: () => void): () => void {
  const panel = document.createElement('section');
  panel.className = 'architect-setup-popover floating-menu';
  panel.id = `team-setup-${crypto.randomUUID()}`;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('Architect & workers'));
  panel.tabIndex = -1;
  panel.innerHTML = `<header class="architect-setup-heading"><h2>${t('Architect & workers')}</h2><button type="button" class="icon-button" aria-label="${t('Close dialog')}">${icon('close')}</button></header><div class="architect-setup-scroll"><div id="architect-setup-host"><p class="architect-loading" role="status">${t('Loading team setup…')}</p></div></div>`;
  const host = panel.querySelector<HTMLElement>('#architect-setup-host')!;
  let closed = false, frame = 0, setup: SetupController | undefined;
  const expanded = anchor.getAttribute('aria-expanded'), controls = anchor.getAttribute('aria-controls');
  function position(): void {
    frame = 0;
    if (closed) return;
    if (!anchor.isConnected) { close(false); return; }
    const view = window.visualViewport;
    const left = (view?.offsetLeft ?? 0) + 12, top = (view?.offsetTop ?? 0) + 12;
    const width = Math.max(0, (view?.width ?? innerWidth) - 24), height = Math.max(0, (view?.height ?? innerHeight) - 24);
    const rect = anchor.getBoundingClientRect();
    const scale = parseFloat(getComputedStyle(document.documentElement).fontSize) / 14;
    panel.style.width = `${Math.min(410 * scale, width)}px`;
    panel.style.maxHeight = `${Math.min(680 * scale, height)}px`;
    const desired = panel.offsetHeight;
    const above = rect.top - top - 8, below = top + height - rect.bottom - 8;
    const placeBelow = below >= desired || below > above;
    const available = placeBelow ? below : above;
    panel.style.maxHeight = `${Math.min(680 * scale, available >= 240 ? available : height)}px`;
    const measured = panel.offsetHeight;
    panel.style.left = `${Math.max(left, Math.min(rect.left, left + width - panel.offsetWidth))}px`;
    panel.style.top = `${Math.max(top, Math.min(placeBelow ? rect.bottom + 8 : rect.top - measured - 8, top + height - measured))}px`;
    panel.dataset.placement = placeBelow ? 'below' : 'above';
  }
  function schedulePosition(): void { if (!closed && !frame) frame = requestAnimationFrame(position); }
  const observer = new ResizeObserver(schedulePosition);
  function close(restoreFocus = true): void {
    if (closed) return;
    closed = true;
    setup?.(); observer.disconnect(); cancelAnimationFrame(frame);
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escapeKey);
    document.removeEventListener('focusin', focusChanged);
    window.removeEventListener('resize', schedulePosition);
    window.removeEventListener('scroll', schedulePosition, true);
    window.visualViewport?.removeEventListener('resize', schedulePosition);
    window.visualViewport?.removeEventListener('scroll', schedulePosition);
    if (expanded === null) anchor.removeAttribute('aria-expanded'); else anchor.setAttribute('aria-expanded', expanded);
    if (controls === null) anchor.removeAttribute('aria-controls'); else anchor.setAttribute('aria-controls', controls);
    hidePopover(panel); onClose();
    if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
  }
  function outside(event: PointerEvent): void {
    const target = event.target as HTMLElement;
    if (panel.contains(target) || anchor.contains(target)) return;
    // Model and profile pickers are portalled next to this surface, not inside it.
    if (setup?.hasChildMenu() && target.closest('.floating-menu')) return;
    close(false);
  }
  function escapeKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented || setup?.hasChildMenu()) return;
    event.preventDefault(); event.stopPropagation(); close();
  }
  function focusChanged(): void {
    queueMicrotask(() => {
      if (!closed && !setup?.hasChildMenu() && document.activeElement !== document.body && !panel.contains(document.activeElement) && !anchor.contains(document.activeElement)) close(false);
    });
  }
  panel.querySelector('button')!.addEventListener('click', () => close());
  panel.addEventListener('keydown', escapeKey);
  anchor.setAttribute('aria-expanded', 'true'); anchor.setAttribute('aria-controls', panel.id);
  document.body.append(panel); position(); showPopover(panel, anchor); panel.focus({ preventScroll: true });
  observer.observe(host);
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', escapeKey);
  document.addEventListener('focusin', focusChanged);
  window.addEventListener('resize', schedulePosition);
  window.addEventListener('scroll', schedulePosition, true);
  window.visualViewport?.addEventListener('resize', schedulePosition);
  window.visualViewport?.addEventListener('scroll', schedulePosition);
  void load().then(options => {
    if (closed || !anchor.isConnected) return;
    setup = mountArchitectSetup(host, options); position();
    if (document.activeElement === panel) panel.querySelector<HTMLElement>('.team-library-picker:not(:disabled), .architect-model:not(:disabled), .architect-setup-heading button')?.focus({ preventScroll: true });
  }).catch(cause => {
    if (closed) return;
    host.innerHTML = '<p class="architect-setup-error" role="alert"></p>';
    host.firstElementChild!.textContent = cause instanceof Error ? cause.message : String(cause); position();
  });
  return () => close();
}

/** Setup stays local until applied. Model and effort changes retain the form and pickers. */
export function mountArchitectSetup(host: HTMLElement, options: SetupOptions): SetupController {
  const { task, team, library, providers } = options;
  const workerProvider = providers.find(p => p.id === 'kimi' && p.installed) ?? providers.find(p => p.installed) ?? providers[0];
  // Automatic and named agent teams have no fixed profiles to edit here; start from a fresh setup.
  const source = team?.pendingSetup?.config ?? team?.config ?? library.lastSetup?.config;
  const config: TeamConfig = structuredClone(source && !source.auto ? source : { workers: [{ id: 'worker-1', name: t('Worker 1'), provider: workerProvider?.id ?? task.provider, model: '', reasoningEffort: null }], maxParallel: 0, maxRounds: 8, maxAssignments: 24, workspace: 'shared', summaryLimit: 3072 });
  const architect: ModelSelection = team?.pendingSetup ? structuredClone(team.pendingSetup.architect) : !team && library.lastSetup && !task.resumeId ? structuredClone(library.lastSetup.architect) : { provider: task.provider, model: task.model, reasoningEffort: task.reasoningEffort ?? null };
  let disposed = false, pending = false, picker: (() => void) | undefined;
  const canDisable = Boolean(team) && !teamActive(team) && !team?.workers.length && !team?.round;
  const setupHelp = t('Applies to the next architect turn. Existing workers keep their models.');
  const parallelHelp = t('Maximum simultaneous assignments. The architect dispatches independent work; overlapping writes or dependencies may wait.');
  const guidanceHelp = t('Extra instructions for the lead, added to the built-in architect rules and sent with them. Leave it empty to use the guidance from Settings → Agent teams, or the built-in rules alone when none is set.');
  host.innerHTML = `<form class="architect-setup"><section class="architect-config-section"><div class="architect-section-label"><h3>${t('Architect')}</h3><span>${t('Plans & reviews')}</span></div><button class="architect-model" type="button" aria-label="${t('Choose architect model')}" aria-haspopup="dialog" aria-expanded="false">${modelMarkup(architect, providers)}</button><div class="architect-guidance"><label for="team-guidance">${t('Lead guidance')}</label>${infoMark(guidanceHelp, t('Lead guidance'))}<span class="sr-only" id="team-guidance-help">${escape(guidanceHelp)}</span><textarea id="team-guidance" name="leadGuidance" rows="3" maxlength="2000" aria-describedby="team-guidance-help" placeholder="${t('Extra instructions for the lead, on top of the built-in team rules.')}">${escape(config.leadGuidance ?? '')}</textarea><button type="button" class="secondary-button architect-guidance-reset">${t('Reset to default')}</button></div></section><section class="architect-config-section"><div class="architect-section-label"><h3>${t('Workers')}</h3><button type="button" class="architect-add" aria-label="${t('Add worker profile')}">${icon('plus')} ${t('Add')}</button></div><div class="architect-profiles"></div></section><section class="architect-parallel"><div class="architect-parallel-controls"><label for="team-parallel">${t('At once')}</label>${infoMark(parallelHelp, t('How parallel workers run'))}<span id="team-parallel-help" class="sr-only">${parallelHelp}</span></div><div class="architect-parallel-controls"><label><input id="team-unlimited" type="checkbox" aria-label="${t('Unlimited workers')}" aria-describedby="team-parallel-help" ${config.maxParallel === 0 ? 'checked' : ''}>${t('Unlimited')}</label><input id="team-parallel" name="maxParallel" aria-label="${t('Workers at once')}" aria-describedby="team-parallel-help" type="number" min="1" step="1" value="${config.maxParallel || 3}" ${config.maxParallel === 0 ? 'hidden' : ''} ${config.maxParallel === 0 ? 'disabled' : ''} required></div></section><details class="architect-limits"><summary>${t('Run limits & context')}</summary><div class="architect-limit-fields"><label>${t('Architect rounds')}<input type="number" name="maxRounds" min="1" max="20" value="${config.maxRounds}" required></label><label>${t('Worker assignments')}<input type="number" name="maxAssignments" min="1" max="50" value="${config.maxAssignments}" required></label><label>${t('Result summary limit')}<input type="number" name="summaryLimit" aria-label="${t('Result summary limit')}" min="512" max="6000" value="${config.summaryLimit}" required><small>${t('Bytes per worker result')}</small></label></div><p>${t('Short summaries keep the architect\'s context focused. Full worker transcripts remain available.')}</p><p>${t('Shared checkout · overlapping write scopes wait. Read-only assignments can run alongside writers. Scopes coordinate work; task permissions apply to every worker.')}</p></details>${task.resumeId && !team ? `<p class="architect-workspace-note">${t('A fresh architect context enables delegation. Your saved conversation stays here.')}</p>` : ''}${team ? `<p class="architect-workspace-note">${t('Next architect turn')} ${infoMark(setupHelp, t('When team changes apply'))}<span class="sr-only">${setupHelp}</span></p>` : ''}<p class="architect-setup-error" role="alert" hidden></p><div class="architect-setup-footer">${canDisable ? `<button class="secondary-button architect-disable" type="button">${t('Use a single agent')}</button>` : `<span>${t('Remembered for new tasks')}</span>`}<button class="primary-button" type="submit">${team && !canDisable ? t('Apply setup') : t('Save setup')}</button></div></form>`;
  const form = host.querySelector<HTMLFormElement>('form')!;
  const guidanceField = host.querySelector<HTMLTextAreaElement>('#team-guidance')!;
  const profiles = host.querySelector<HTMLElement>('.architect-profiles')!;
  const error = host.querySelector<HTMLElement>('.architect-setup-error')!;
  const libraryHost = document.createElement('section');
  form.prepend(libraryHost);
  const disabledControls = new Map<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement, boolean>();
  function setBusy(value: boolean): void {
    pending = value;
    if (value) { picker?.(); form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>('input,button,textarea').forEach(el => { disabledControls.set(el, el.disabled); el.disabled = true; }); }
    else { disabledControls.forEach((disabled, el) => { el.disabled = disabled; }); disabledControls.clear(); }
  }
  function readSetup(): TeamSetup {
    for (const name of ['maxRounds', 'maxAssignments', 'summaryLimit'] as const) config[name] = Number((form.elements.namedItem(name) as HTMLInputElement).value);
    config.leadGuidance = guidanceField.value.trim() || null;
    return structuredClone({ architect, config });
  }
  const savedProfiles = mountTeamProfiles(libraryHost, { library, pendingSetup: team?.pendingSetup, read: readSetup, busy: setBusy,
    apply: setup => {
      if (!team && task.resumeId && setup.architect.provider !== task.provider) throw new Error(t('Use a new task to switch the architect harness.'));
      picker?.(); Object.assign(config, structuredClone(setup.config)); Object.assign(architect, structuredClone(setup.architect));
      renderProfiles(); refreshModelLabels();
      for (const name of ['maxRounds', 'maxAssignments', 'summaryLimit'] as const) (form.elements.namedItem(name) as HTMLInputElement).value = String(config[name]);
      guidanceField.value = config.leadGuidance ?? '';
      parallel.value = String(config.maxParallel || 3); refreshParallel();
      error.hidden = true;
    },
  });
  form.addEventListener('input', () => savedProfiles.changed());
  host.querySelector<HTMLButtonElement>('.architect-guidance-reset')!.addEventListener('click', () => { guidanceField.value = ''; guidanceField.focus(); savedProfiles.changed(); });
  form.addEventListener('invalid', event => { (event.target as HTMLElement).closest('details')?.setAttribute('open', ''); }, true);
  function choose(anchor: HTMLButtonElement, selection: ModelSelection, canSwitchProvider: boolean): void {
    picker?.();
    picker = openModelPicker({ anchor, providers, current: { ...selection, model: selection.model || 'default' }, canSwitchProvider, loadModels: options.loadModels,
      onSelect: async (provider, model) => { selection.provider = provider; selection.model = model; selection.reasoningEffort = null; anchor.innerHTML = modelMarkup(selection, providers); savedProfiles.changed(); },
      onEffortSelect: async effort => { selection.reasoningEffort = effort; anchor.innerHTML = modelMarkup(selection, providers); savedProfiles.changed(); },
      onClose: () => { picker = undefined; },
    });
  }
  function renderProfiles(): void {
    profiles.innerHTML = config.workers.map((profile, index) => `<div class="architect-profile" data-profile-id="${escape(profile.id)}"><div class="architect-profile-heading"><span class="architect-profile-number">${index + 1}</span><input aria-label="${t(`Worker profile ${index + 1} name`)}" maxlength="60" value="${escape(profile.name)}"><button type="button" class="icon-button" aria-label="${t(`Remove worker profile ${index + 1}`)}" ${config.workers.length === 1 ? 'disabled' : ''}>${icon('close')}</button></div><button type="button" class="architect-model" aria-label="${t(`Choose model for worker ${index + 1}`)}" aria-haspopup="dialog" aria-expanded="false">${modelMarkup(profile, providers)}</button></div>`).join('');
    profiles.querySelectorAll<HTMLElement>('.architect-profile').forEach((row, index) => {
      row.querySelector('input')!.addEventListener('input', event => { config.workers[index].name = (event.target as HTMLInputElement).value; });
      row.querySelector('.icon-button')!.addEventListener('click', () => { picker?.(); config.workers.splice(index, 1); renderProfiles(); savedProfiles.changed(); });
      row.querySelector<HTMLButtonElement>('.architect-model')!.addEventListener('click', event => choose(event.currentTarget as HTMLButtonElement, config.workers[index], true));
    });
    (host.querySelector('.architect-add') as HTMLButtonElement).disabled = config.workers.length >= 6;
  }
  renderProfiles();
  function refreshModelLabels(): void {
    if (disposed) return;
    host.querySelector<HTMLButtonElement>('.architect-model')!.innerHTML = modelMarkup(architect, providers);
    profiles.querySelectorAll<HTMLElement>('.architect-profile').forEach(row => {
      const profile = config.workers.find(profile => profile.id === row.dataset.profileId);
      if (profile) row.querySelector<HTMLElement>('.architect-model')!.innerHTML = modelMarkup(profile, providers);
    });
  }
  void Promise.allSettled([...new Set(providers.filter(p => p.installed).map(p => p.id))].map(options.loadModels)).then(refreshModelLabels);
  host.querySelector<HTMLButtonElement>('.architect-model')!.addEventListener('click', event => choose(event.currentTarget as HTMLButtonElement, architect, Boolean(team) || !task.resumeId));
  host.querySelector('.architect-add')!.addEventListener('click', () => {
    picker?.(); config.workers.push({ ...config.workers[config.workers.length - 1], id: crypto.randomUUID(), name: t`Worker ${config.workers.length + 1}` }); renderProfiles(); savedProfiles.changed();
    profiles.lastElementChild?.querySelector<HTMLInputElement>('input')?.select();
  });
  const parallel = host.querySelector<HTMLInputElement>('#team-parallel')!;
  const unlimited = host.querySelector<HTMLInputElement>('#team-unlimited')!;
  function refreshParallel(): void {
    unlimited.checked = config.maxParallel === 0;
    parallel.hidden = unlimited.checked;
    parallel.disabled = unlimited.checked;
  }
  unlimited.addEventListener('change', () => {
    const count = parallel.valueAsNumber;
    config.maxParallel = unlimited.checked ? 0 : Number.isSafeInteger(count) && count > 0 ? count : 3;
    if (!unlimited.checked) parallel.value = String(config.maxParallel);
    refreshParallel(); savedProfiles.changed();
    if (!unlimited.checked) parallel.focus();
  });
  parallel.addEventListener('input', () => {
    const count = parallel.valueAsNumber;
    config.maxParallel = Number.isSafeInteger(count) && count > 0 ? count : NaN;
  });
  async function save(disable = false): Promise<void> {
    if (disposed || pending || (disable && !canDisable)) return;
    if (!disable && !form.reportValidity()) return;
    error.hidden = true;
    for (const name of ['maxRounds', 'maxAssignments', 'summaryLimit'] as const) config[name] = Number((form.elements.namedItem(name) as HTMLInputElement).value);
    config.leadGuidance = guidanceField.value.trim() || null;
    if (!disable && !unlimited.checked && (!Number.isSafeInteger(config.maxParallel) || config.maxParallel < 1)) { error.textContent = t('Choose a whole worker count or Unlimited.'); error.hidden = false; return; }
    if (!disable && new TextEncoder().encode(config.leadGuidance ?? '').length > 2000) { error.textContent = t('Lead guidance must be under 2000 bytes.'); error.hidden = false; guidanceField.focus(); return; }
    if (!disable && config.workers.some(p => !p.name.trim())) { error.textContent = t('Give each worker profile a name.'); error.hidden = false; return; }
    const profileId = disable ? null : savedProfiles.selectedId();
    setBusy(true);
    try { await options.save(disable ? null : config, architect, profileId); }
    catch (cause) { if (!disposed) { error.textContent = String(cause instanceof Error ? cause.message : cause); error.hidden = false; } }
    finally { if (!disposed) { setBusy(false); savedProfiles.changed(); } }
  }
  form.addEventListener('submit', event => { event.preventDefault(); event.stopPropagation(); void save(); });
  host.querySelector('.architect-disable')?.addEventListener('click', () => { void save(true); });
  return Object.assign(() => { disposed = true; picker?.(); savedProfiles.dispose(); }, { hasChildMenu: () => Boolean(picker) || savedProfiles.hasMenu() });
}

// An open worker transcript keeps a bounded window of messages in memory and the DOM.
const WINDOW_MESSAGES = 200, WINDOW_CHARS = 2_000_000;
type WorkerLive = { body: TailText; readonly text: string; tools: Map<string, ToolActivity>; approvals: Map<string, string>; inputs: Map<string, AgentInput>; ended: boolean };
/** The selected worker is painted per frame. Background workers keep bounded data only. */
export class ArchitectView {
  readonly host = document.createElement('div');
  private trigger = document.createElement('button');
  private taskId = '';
  private team: TeamSnapshot | null = null;
  private panel?: HTMLElement;
  private selected = '';
  private live = new Map<string, WorkerLive>();
  private rows = new Map<string, HTMLButtonElement>();
  private paintedTools = new Map<string, ToolActivity>();
  private paintedWorker = '';
  private frame = 0;
  private paintFrame = 0;
  private agentsSignal = '';
  private request = 0;
  private historyWorker = '';
  private historyMessages = new Map<number, Message>();
  private historyPaints = new WeakMap<HTMLElement, Message>();
  private historyHasOlder = false;
  /** Paging back dropped the newest messages; scrolling to the bottom reloads the latest. */
  private historyTrimmedNewer = false;
  private historyLoading = false;
  private historyRefreshQueued = false;
  private busy = false;
  private providers: Provider[] = [];
  private assistEnabled = false;
  private childAgents?: Subagents;
  private teamMessages?: TeamMessages;
  constructor(private options: { setup: (anchor: HTMLElement) => void; loadModels: (provider: ProviderId) => Promise<ProviderModel[]>; updated: (team: TeamSnapshot) => void; report: (error: unknown) => void; onFork?: (sessionId: string, messageId: number) => Promise<void>; fileContext?: (sessionId: string) => FileLinkContext | undefined; assist?: (sessionId: string, kind: 'review' | 'route') => void; remote?: (sessionId: string) => boolean }) {
    this.host.className = 'architect-host'; this.host.hidden = true;
    this.trigger.className = 'architect-trigger'; this.trigger.type = 'button'; this.trigger.setAttribute('aria-label', t('Open workers')); this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.addEventListener('click', () => this.panel ? this.close() : this.open()); this.host.append(this.trigger);
    this.host.addEventListener('keydown', event => { if (event.key === 'Escape' && this.panel) { event.preventDefault(); event.stopPropagation(); this.close(); this.trigger.focus(); } });
    bindMessageActions(this.host, {
      // A team on another computer has its workers' messages only as loaded from the host.
      content: (sessionId, key) => key === 'live' ? this.live.get(sessionId)?.text : this.options.remote?.(this.taskId) ? (this.historyWorker === sessionId ? this.historyMessages.get(Number(key))?.content : undefined) : call<string>('get_message_content', {sessionId, messageId: Number(key)}),
      onFork: options.onFork, report: options.report,
    });
  }
  setAssistEnabled(enabled: boolean): void { this.assistEnabled = enabled; this.paintAssist(); }
  private paintAssist(): void {
    const button = this.panel?.querySelector<HTMLButtonElement>('.architect-assist'); if (!button) return;
    button.hidden = !this.assistEnabled || !this.options.assist;
    button.textContent = this.selected ? t('Review with Jev') : t('Suggest worker');
  }
  setTask(taskId: string, team: TeamSnapshot | null, providers: Provider[]): void {
    const same = taskId === this.taskId && team;
    if (taskId !== this.taskId) this.close();
    this.taskId = taskId; this.providers = providers; this.team = team;
    // The same task repaints at most once a frame (renderComposer calls this on every render).
    if (same) this.schedulePaint(); else this.paint();
  }
  update(team: TeamSnapshot): void {
    if (team.sessionId === this.taskId && (!this.team || team.revision >= this.team.revision)) {
      const unchanged = this.team && teamSignature(this.team) === teamSignature(team);
      this.team = team;
      // Only a new revision: nothing to repaint, though team messages may have arrived.
      if (!unchanged) this.schedulePaint(); else if (this.panel && !this.selected) this.teamMessages?.update(team);
      // A team on another computer streams no worker events here: reread the open transcript.
      if (this.selected && this.options.remote?.(team.sessionId)) void this.loadMessages();
    }
    // Retain only active worker streams and unresolved requests, not completed histories.
    for (const worker of team.workers) if (!['running', 'waiting'].includes(worker.status) && worker.id !== this.selected) {
      const live = this.live.get(worker.sessionId); if (live?.ended && !live.approvals.size && !live.inputs.size) this.live.delete(worker.sessionId);
    }
  }
  receive(event: AgentEvent): void {
    if (event.kind === 'subagent') { this.childAgents?.receive(event.sessionId, event.data); return; }
    if (event.kind === 'turn_changes') { if (this.worker()?.sessionId === event.sessionId) void this.loadMessages(); return; }
    if (!['message_start', 'text', 'tool', 'approval', 'approval_cancelled', 'input_request', 'input_cancelled', 'done', 'error'].includes(event.kind)) return;
    let live = this.live.get(event.sessionId);
    if (!live) { live = { body: new TailText(), get text() { return this.body.value; }, tools: new Map(), approvals: new Map(), inputs: new Map(), ended: false }; this.live.set(event.sessionId, live); }
    if (event.kind === 'message_start') {
      live.body.set(''); live.tools.clear(); live.ended = false;
      if (this.worker()?.sessionId === event.sessionId) void this.loadMessages();
    }
    if (event.kind === 'text') { live.body.append(event.text); live.ended = false; }
    if (event.kind === 'tool' && event.tool) { const first = !live.tools.has(event.tool.id); live.tools.set(event.tool.id, event.tool);
      if (first && this.worker()?.sessionId === event.sessionId) void this.loadMessages(); while (live.tools.size > 40) live.tools.delete(live.tools.keys().next().value!); }
    if (event.kind === 'approval' && event.requestId) live.approvals.set(event.requestId, event.text);
    if (event.kind === 'approval_cancelled' && event.requestId) live.approvals.delete(event.requestId);
    if (event.kind === 'input_request' && event.requestId && !live.inputs.has(event.requestId)) {
      const requestId = event.requestId, current = live;
      current.inputs.set(requestId, createAgentInput(event.sessionId, requestId, event.data, () => { current.inputs.get(requestId)?.dispose(); current.inputs.delete(requestId); this.schedule(); }));
    }
    if (event.kind === 'input_cancelled' && event.requestId) { live.inputs.get(event.requestId)?.dispose(); live.inputs.delete(event.requestId); }
    if (event.kind === 'done') {
      const context = this.options.fileContext?.(event.sessionId); if (context) refreshFileLinks(context);
      live.ended = true; live.approvals.clear(); for (const input of live.inputs.values()) input.dispose(); live.inputs.clear();
      if (this.worker()?.sessionId === event.sessionId) void this.loadMessages();
      else this.live.delete(event.sessionId);
    }
    // Stale unknown terminal events must not accumulate stream objects forever.
    while (this.live.size > 8) { const entry = [...this.live].find(([, value]) => value.ended && !value.inputs.size && !value.approvals.size); if (!entry) break; this.live.delete(entry[0]); }
    if (['approval', 'approval_cancelled', 'input_request', 'input_cancelled', 'done'].includes(event.kind)) this.paint();
    if (event.sessionId === this.worker()?.sessionId) this.schedule();
  }
  /** A worker is asking for an approval or an answer the user has not given yet. */
  needsInput(sessionId: string): boolean { const live = this.live.get(sessionId); return Boolean(live?.approvals.size || live?.inputs.size); }
  private worker(): TeamWorker | undefined { return this.team?.workers.find(w => w.id === this.selected); }
  private schedulePaint(): void { this.paintFrame ||= requestAnimationFrame(() => { this.paintFrame = 0; this.paint(); }); }
  private schedule(): void { if (this.frame || !this.panel) return; this.frame = requestAnimationFrame(() => { this.frame = 0; this.paintLive(); }); }
  /** For the dock's Agents item: whether a team exists, how many workers run, and the panel. */
  get present(): boolean { return Boolean(this.team); }
  get running(): number { return this.team?.workers.filter(worker => worker.status === 'running').length ?? 0; }
  get isOpen(): boolean { return Boolean(this.panel); }
  open(focus = true): void {
    if (!this.team || this.panel) return;
    this.childAgents?.setTask('', false);
    const panel = document.createElement('section'); panel.className = 'architect-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', t('Workers'));
    panel.innerHTML = `<div class="architect-panel-heading"><button class="icon-button architect-back" aria-label="${t('Back to workers')}" hidden>${icon('back')}</button><strong class="architect-panel-summary"></strong><small class="architect-panel-count"></small><span class="architect-panel-controls"><button class="icon-button" data-team-control="pause" aria-label="${t('Pause team')}" title="${t('Pause team')}">${icon('pause')}</button><button class="icon-button" data-team-control="resume" aria-label="${t('Resume team')}" title="${t('Resume team')}">${icon('play')}</button><button class="icon-button" data-team-control="stop" aria-label="${t('Stop team')}" title="${t('Stop team')}">${icon('stop')}</button><button class="icon-button architect-configure" aria-label="${t('View team setup')}" title="${t('Team setup')}">${icon('settings')}</button></span><button class="icon-button architect-close" aria-label="${t('Close workers')}" title="${t('Close')}">${icon('close')}</button></div><p class="architect-panel-error" role="status" hidden></p><div class="architect-panel-scroll"><div class="architect-worker-list"></div><div class="architect-worker-detail" hidden><div class="architect-worker-meta"></div><details class="architect-assignment"><summary>${t('Assignment & file scope')}</summary><p></p><small></small></details><details class="architect-worker-checkpoint" hidden><summary>${t('Latest checkpoint ')}<time></time></summary><dl><div><dt>${t('Progress')}</dt><dd data-checkpoint="summary"></dd></div><div><dt>${t('Next')}</dt><dd data-checkpoint="nextSteps"></dd></div><div class="architect-checkpoint-blocker"><dt>${t('Blocked')}</dt><dd data-checkpoint="blocker"></dd></div></dl></details><div class="architect-worker-history"></div><div class="architect-worker-live"></div><div class="architect-worker-tools"></div><div class="architect-worker-approvals"></div><div class="architect-worker-inputs"></div><p class="architect-worker-empty" role="status"></p><button class="secondary-button architect-history-retry" hidden>${t('Retry loading worker')}</button></div></div>`;
    this.panel = panel; this.host.append(panel);
    const assist = document.createElement('button'); assist.type = 'button'; assist.className = 'architect-assist';
    assist.addEventListener('click', () => {
      const worker = this.worker(), target = worker?.sessionId ?? this.taskId;
      const kind = worker ? 'review' : 'route';
      this.close(); this.options.assist?.(target, kind);
    });
    panel.querySelector('.architect-panel-controls')!.append(assist);
    this.paintAssist();
    // Messages between teammates stay on the host of a team on another computer.
    if (!this.options.remote?.(this.taskId)) {
      this.teamMessages = new TeamMessages(this.team);
      panel.querySelector('.architect-worker-list')!.after(this.teamMessages.host);
    }
    panel.querySelector('.architect-close')!.addEventListener('click', () => { this.close(); this.trigger.focus(); });
    panel.querySelector('.architect-back')!.addEventListener('click', () => { this.selected = ''; this.historyWorker = ''; this.historyLoading = false; this.historyRefreshQueued = false; ++this.request; this.paint(); });
    panel.querySelector('.architect-configure')!.addEventListener('click', event => this.options.setup(event.currentTarget as HTMLElement));
    panel.querySelectorAll<HTMLButtonElement>('[data-team-control]').forEach(control => control.addEventListener('click', () => { void this.control(control.dataset.teamControl!); }));
    panel.querySelector('.architect-history-retry')!.addEventListener('click', () => { void this.loadMessages(); });
    const scroll = panel.querySelector<HTMLElement>('.architect-panel-scroll')!;
    scroll.addEventListener('scroll', () => { if (scroll.scrollTop < 72) void this.loadMessages(true); else if (this.historyTrimmedNewer && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 72) void this.loadMessages(); }, { passive: true });
    scroll.addEventListener('wheel', event => { if (event.deltaY < 0 && scroll.scrollTop < 72) void this.loadMessages(true); }, { passive: true });
    void Promise.allSettled([...new Set(this.team.config.workers.map(worker => worker.provider))].map(this.options.loadModels)).then(() => { if (this.panel === panel) this.paint(); });
    this.trigger.setAttribute('aria-expanded', 'true'); this.paint(); showPopover(panel, this.trigger); if (focus) panel.querySelector<HTMLButtonElement>('.architect-close')!.focus();
  }
  async openWorker(workerId: string, subagentId?: string): Promise<void> {
    const worker = this.team?.workers.find(worker => worker.id === workerId);
    if (!worker) throw new Error(t('This worker is no longer available.'));
    if (subagentId) {
      this.close();
      if (!this.childAgents) {
        const host = document.createElement('div'); host.className = 'subagents-host';
        this.host.after(host); this.childAgents = new Subagents(host, 'worker-subagents-panel', this.options.fileContext);
      }
      this.childAgents.setTask(worker.sessionId, true);
      await this.childAgents.showAgent(subagentId);
      return;
    }
    this.open(); this.selected = workerId; this.paint();
    this.panel?.querySelector<HTMLButtonElement>('.architect-back')?.focus();
    await this.loadMessages();
  }
  close(): void { this.teamMessages?.destroy(); this.teamMessages = undefined; this.childAgents?.setTask('', false); if (this.panel) hidePopover(this.panel); this.panel = undefined; this.selected = ''; this.rows.clear(); this.paintedTools.clear(); this.paintedWorker = ''; this.historyWorker = ''; this.historyMessages.clear(); this.historyHasOlder = false; this.historyTrimmedNewer = false; this.historyLoading = false; this.historyRefreshQueued = false; this.request++; cancelAnimationFrame(this.frame); this.frame = 0; this.trigger.setAttribute('aria-expanded', 'false'); }
  private async control(action: string): Promise<void> {
    if (this.busy || !this.team) return;
    this.busy = true; this.paint();
    try { const team = await call<TeamSnapshot>('architect_control', { sessionId: this.taskId, action }); this.options.updated(team); }
    catch (error) { this.options.report(error); }
    finally { this.busy = false; this.paint(); }
  }
  private paint(): void {
    cancelAnimationFrame(this.paintFrame); this.paintFrame = 0;
    const team = this.team; this.host.hidden = !team;
    // The dock's Agents item reads only whether a team exists and how many workers run.
    const agents = team ? String(this.running) : '';
    if (agents !== this.agentsSignal) { this.agentsSignal = agents; dispatchEvent(new Event('pandacode:agents')); }
    if (!team) { this.close(); return; }
    const done = team.workers.filter(w => w.status === 'completed' || w.abandoned).length;
    const asking = team.workers.some(w => this.needsInput(w.sessionId));
    const progress = asking ? t('Needs input') : team.workers.length ? `${done}/${team.workers.length}` : t('Ready');
    const trigger = `${icon('worktree')}<span>${t('Architect & workers')}</span><small>${progress}</small>${icon('chevron')}`;
    if (this.trigger.dataset.painted !== trigger) { this.trigger.innerHTML = trigger; this.trigger.dataset.painted = trigger; }
    this.trigger.dataset.status = asking ? 'waiting' : team.status;
    if (!this.panel) return;
    const panel = this.panel, worker = this.worker();
    this.paintAssist();
    // Auto teams have nothing to set up: the lead picks worker models.
    panel.querySelector<HTMLElement>('.architect-configure')!.hidden = Boolean(team.config.auto);
    panel.querySelector<HTMLElement>('.architect-panel-summary')!.textContent = teamActive(team) ? t('Architect is working…') : statusNames[team.status];
    const count = panel.querySelector<HTMLElement>('.architect-panel-count')!;
    count.textContent = team.workers.length === 1 ? t`1 task` : t`${team.workers.length} tasks`; count.title = t`Round ${team.round}/${team.config.maxRounds}`;
    panel.querySelector<HTMLButtonElement>('[data-team-control=pause]')!.hidden = !teamActive(team);
    panel.querySelector<HTMLButtonElement>('[data-team-control=stop]')!.hidden = !teamActive(team) && team.status !== 'paused';
    // Resume at the round limit grants more rounds natively, up to the maximum of 20.
    panel.querySelector<HTMLButtonElement>('[data-team-control=resume]')!.hidden = !['paused', 'failed', 'interrupted'].includes(team.status) || team.round >= MAX_ROUNDS;
    panel.querySelectorAll<HTMLButtonElement>('[data-team-control]').forEach(button => { button.disabled = this.busy; });
    // Teams running on another computer are shown read-only.
    panel.querySelector<HTMLElement>('.architect-panel-controls')!.hidden = Boolean(this.options.remote?.(this.taskId));
    const error = panel.querySelector<HTMLElement>('.architect-panel-error')!; error.textContent = team.error ?? ''; error.hidden = !team.error;
    // Pausing or stopping is the user's own choice, not a failure.
    error.classList.toggle('is-notice', team.status === 'paused' && /^Team (paused|stopped)\./.test(team.error ?? ''));
    panel.querySelector<HTMLElement>('.architect-back')!.hidden = !worker;
    panel.querySelector<HTMLElement>('.architect-worker-list')!.hidden = Boolean(worker);
    panel.querySelector<HTMLElement>('.architect-worker-detail')!.hidden = !worker;
    if (this.teamMessages) { this.teamMessages.host.hidden = Boolean(worker); if (!worker) this.teamMessages.update(team); }
    if (worker) {
      const meta = panel.querySelector<HTMLElement>('.architect-worker-meta')!;
      const queueReason = workerQueueReason(worker, team.workers, team.config.maxParallel);
      meta.innerHTML = `${providerLogo(worker.provider)}<div class="architect-worker-copy"><strong>${escape(worker.name)}</strong><small>${escape(modelName(worker, this.providers))} · ${escape(statusNames[worker.status])}${worker.readOnly ? t(' · Read only') : ''}</small>${queueReason ? `<small class="architect-worker-queue" role="status" data-tip="${escape(queueReason)}">${escape(queueReason)}</small>` : ''}${worker.error ? `<small class="architect-worker-error" role="status">${escape(worker.error)}</small>` : ''}</div>`;
      panel.querySelector<HTMLElement>('.architect-assignment p')!.textContent = worker.assignment;
      panel.querySelector<HTMLElement>('.architect-assignment small')!.textContent = worker.readOnly ? t('Read only · no writes') : worker.files.length ? t`Write scope: ${worker.files.join(', ')}` : t('Write scope: shared checkout');
      const checkpoint = panel.querySelector<HTMLDetailsElement>('.architect-worker-checkpoint')!;
      checkpoint.hidden = !worker.checkpoint;
      if (checkpoint.dataset.workerId !== worker.id) { checkpoint.open = false; checkpoint.dataset.workerId = worker.id; }
      if (worker.checkpoint) {
        for (const name of ['summary', 'nextSteps', 'blocker'] as const) {
          const value = worker.checkpoint[name] ?? '';
          const field = checkpoint.querySelector<HTMLElement>(`[data-checkpoint="${name}"]`)!;
          if (field.textContent !== value) field.textContent = value;
          field.parentElement!.hidden = !value;
        }
        const time = checkpoint.querySelector('time')!;
        const updated = new Date(worker.checkpoint.updatedAt);
        time.dateTime = updated.toISOString(); time.textContent = updated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      }
      panel.querySelector('.architect-panel-scroll')!.classList.remove('is-overflowing');
      this.paintLive(); return;
    }
    const list = panel.querySelector<HTMLElement>('.architect-worker-list')!;
    if (!team.workers.length) { list.textContent = team.status === 'ready' ? t('Send a task to let the architect delegate the work.') : t('The architect is planning its first assignments.'); return; }
    if (!this.rows.size) list.replaceChildren();
    // Sub-workers sit indented under their parent.
    const ordered = team.workers.filter(w => !w.parentWorker).flatMap(parent => [parent, ...team.workers.filter(w => w.parentWorker === parent.id)]);
    ordered.forEach((worker, index) => {
      let row = this.rows.get(worker.id);
      if (!row) { row = document.createElement('button'); row.className = 'architect-worker-row'; row.type = 'button'; row.dataset.workerId = worker.id; row.addEventListener('click', () => { this.selected = worker.id; this.paint(); void this.loadMessages(); }); this.rows.set(worker.id, row); if (worker.parentWorker) row.style.paddingInlineStart = '32px'; }
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
      const live = this.live.get(worker.sessionId);
      const needsInput = Boolean(live?.approvals.size || live?.inputs.size);
      row.dataset.status = needsInput ? 'waiting' : worker.status;
      const queueReason = workerQueueReason(worker, team.workers, team.config.maxParallel);
      const [verb, tone] = worker.abandoned ? [t('Resolved'), ''] : needsInput ? [t('Needs input'), 'accent'] : workerVerbs[worker.status] ?? [statusNames[worker.status] ?? worker.status, ''];
      const glyph = worker.abandoned ? 'idle' : needsInput || ['queued', 'waiting', 'parked'].includes(worker.status) ? 'pending' : workerGlyphs[worker.status] ? worker.status : 'idle';
      const markup = `<span class="architect-worker-glyph" data-glyph="${glyph}">${workerGlyphs[glyph]}<span class="architect-worker-logo">${providerLogo(worker.provider)}</span></span><span class="architect-worker-copy"><strong>${escape(worker.name)}</strong><small${queueReason ? ` data-tip="${escape(queueReason)}"` : ''}><span class="architect-worker-state"${tone ? ` data-tone="${tone}"` : ''}>${escape(verb)}</span> ${escape(queueReason ?? modelName(worker, this.providers))}</small></span>${icon('chevron')}`;
      if (row.dataset.painted !== markup) { row.innerHTML = markup; row.dataset.painted = markup; }
    });
    const scroll = panel.querySelector<HTMLElement>('.architect-panel-scroll')!;
    scroll.classList.toggle('is-overflowing', scroll.scrollHeight > scroll.clientHeight + 1);
  }
  private async loadMessages(older = false): Promise<void> {
    const worker = this.worker(), panel = this.panel; if (!worker || !panel) return;
    const history = panel.querySelector<HTMLElement>('.architect-worker-history')!, scroll = panel.querySelector<HTMLElement>('.architect-panel-scroll')!;
    if (!older && this.historyTrimmedNewer && this.historyWorker === worker.sessionId) {
      // Without forward paging, the latest window is reloaded once the reader is back at the bottom.
      if (this.historyLoading || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight >= 72) return;
      this.historyWorker = '';
    }
    if (this.historyWorker !== worker.sessionId) {
      if (older) return;
      this.request++; this.historyWorker = worker.sessionId; this.historyMessages.clear();
      this.historyHasOlder = false; this.historyTrimmedNewer = false; this.historyLoading = false; this.historyRefreshQueued = false;
      history.replaceChildren(); scroll.scrollTop = 0;
    }
    if (this.historyLoading) { if (!older) this.historyRefreshQueued = true; return; }
    if (older && !this.historyHasOlder) return;
    const beforeId = older ? Math.min(...this.historyMessages.keys()) : undefined;
    if (older && !Number.isFinite(beforeId)) return;
    const initial = this.historyMessages.size === 0, request = this.request, taskId = this.taskId;
    const current = () => this.request === request && this.panel === panel && this.worker()?.sessionId === worker.sessionId;
    const fileContext = this.options.fileContext?.(worker.sessionId);
    const liveAtRequest = this.live.get(worker.sessionId), textAtRequest = liveAtRequest?.text;
    const empty = panel.querySelector<HTMLElement>('.architect-worker-empty')!, retry = panel.querySelector<HTMLButtonElement>('.architect-history-retry')!;
    if (initial) empty.textContent = t('Loading worker…');
    retry.hidden = true; this.historyLoading = true;
    let loaded = false;
    try {
      const command = this.options.remote?.(taskId) ? 'remote_worker_messages' : 'architect_worker_messages';
      const page = await call<MessagePage>(command, { sessionId: taskId, workerId: worker.id, ...(beforeId ? { beforeId } : {}) });
      if (!current()) return;
      // A completed worker can persist more than one page between refreshes.
      // Fill that gap before merging, without discarding scrollback already read.
      const newest = this.historyMessages.size ? Math.max(...this.historyMessages.keys()) : undefined;
      let first = page.messages[0]?.id;
      while (!older && newest !== undefined && first !== undefined && first > newest && page.hasOlder) {
        const gap = await call<MessagePage>(command, { sessionId: taskId, workerId: worker.id, beforeId: first });
        if (!current()) return;
        if (!gap.messages.length || gap.messages[0].id >= first) break;
        page.messages = [...gap.messages, ...page.messages]; page.hasOlder = gap.hasOlder; first = page.messages[0].id;
      }
      const previousFirst = this.historyMessages.size ? Math.min(...this.historyMessages.keys()) : undefined;
      const incoming = older ? page.messages.filter(message => message.id < beforeId!) : page.messages;
      for (const message of incoming) this.historyMessages.set(message.id, message);
      if (older) this.historyHasOlder = page.hasOlder && incoming.length > 0;
      else if (previousFirst === undefined || first !== undefined && first <= previousFirst) this.historyHasOlder = page.hasOlder;
      this.trimHistory(older);
      const restore = older ? captureTranscriptAnchor(scroll) : preserveTranscriptPosition(scroll);
      const changeViews = captureChangeCards(history);
      const openedTools = new Set([...history.querySelectorAll<HTMLDetailsElement>('details[data-tool-key][open]')].map(tool => tool.dataset.toolKey!));
      const fragment = document.createDocumentFragment();
      const existing = new Map([...history.querySelectorAll<HTMLElement>(':scope > [data-message-id]')].map(article => [Number(article.dataset.messageId), article]));
      let pendingChanges: import('./types').TurnChanges | null | undefined;
      const appendChanges = (changes: import('./types').TurnChanges) => {
        const container = document.createElement('div'); container.innerHTML = renderTurnChanges(worker.sessionId, changes);
        fragment.append(...container.childNodes);
      };
      for (const message of [...this.historyMessages.values()].sort((a, b) => a.id - b.id)) {
        if (message.role === 'user' || message.role === 'coordination') { if (pendingChanges) appendChanges(pendingChanges); pendingChanges = message.turnChanges; }
        const previous = existing.get(message.id), painted = previous && this.historyPaints.get(previous);
        if (previous && painted?.content === message.content && painted.role === message.role) {
          fragment.append(previous);
          if (message.role === 'changes') { if (message.turnChanges) appendChanges(message.turnChanges); pendingChanges = undefined; }
          continue;
        }
        const article = document.createElement('article'); article.className = 'architect-worker-message'; article.dataset.messageId = String(message.id);
        this.historyPaints.set(article, message);
        if (message.role === 'changes') { article.hidden = true; fragment.append(article); if (message.turnChanges) appendChanges(message.turnChanges); pendingChanges = undefined; continue; }
        if (message.role === 'coordination') article.innerHTML = renderCoordination(message);
        else if (message.role === 'tool') { const tool = decodeToolActivity(message.content); if (tool) {
            const current = this.live.get(worker.sessionId);
            if (tool.status !== 'running' && current?.tools.get(tool.id)?.status === 'running') current.tools.set(tool.id, tool);
            article.dataset.savedToolId = tool.id; article.innerHTML = renderToolActivity(tool, 'tool:' + tool.id); } else article.textContent = message.content; }
        else { const label = document.createElement('small'); label.textContent = message.role === 'assistant' ? worker.name : message.role === 'user' ? t('Assignment') : t('Activity'); const body = document.createElement('div'); article.append(label, body); bindFileLinkContext(body, fileContext); void markdown(body, message.content, scroll);
          if (message.role === 'user' || message.role === 'assistant') {
            article.insertAdjacentHTML('beforeend', messageActionsHtml(worker.sessionId, message.id, Boolean(this.options.onFork) && message.id > 0 && !this.options.remote?.(taskId)));
          }
        }
        fragment.append(article);
      }
      if (pendingChanges) appendChanges(pendingChanges);
      history.replaceChildren(fragment);
      restoreChangeCards(history, changeViews);
      history.querySelectorAll<HTMLDetailsElement>('details[data-tool-key]').forEach(tool => { tool.open = openedTools.has(tool.dataset.toolKey!); });
      const live = this.live.get(worker.sessionId);
      // An earlier page is only history: it must never clear newer live output.
      if (!older && live && live === liveAtRequest && live.text === textAtRequest) {
        if (live.ended) { live.body.set(''); live.tools.clear(); }
        else if (page.messages.some(message => message.role === 'assistant' && message.content === live.text)) live.body.set('');
      }
      empty.textContent = !this.historyMessages.size && !live?.text ? worker.error || worker.summary || (worker.status === 'queued' ? '' : t('Waiting for the worker’s first response.')) : '';
      this.paintLive();
      if (initial) scroll.scrollTop = scroll.scrollHeight; else restore();
      loaded = true;
    } catch (error) { if (current()) { empty.textContent = String(error instanceof Error ? error.message : error); retry.hidden = false; } }
    finally {
      if (current()) {
        this.historyLoading = false;
        if (this.historyRefreshQueued) { this.historyRefreshQueued = false; void this.loadMessages(); }
        else if (loaded && scroll.scrollHeight <= scroll.clientHeight + 80) void this.loadMessages(true);
      }
    }
  }
  /** Drops the newest messages after paging back, else the oldest, until the window fits. */
  private trimHistory(older: boolean): void {
    const ids = [...this.historyMessages.keys()].sort((a, b) => a - b);
    let chars = 0; for (const message of this.historyMessages.values()) chars += message.content.length;
    while (ids.length > 1 && (ids.length > WINDOW_MESSAGES || chars > WINDOW_CHARS)) {
      const id = older ? ids.pop()! : ids.shift()!;
      chars -= this.historyMessages.get(id)!.content.length; this.historyMessages.delete(id);
      if (older) this.historyTrimmedNewer = true; else this.historyHasOlder = true;
    }
  }
  private paintLive(): void {
    const worker = this.worker(), panel = this.panel; if (!worker || !panel) return;
    const live = this.live.get(worker.sessionId);
    const output = panel.querySelector<HTMLElement>('.architect-worker-live')!;
    bindFileLinkContext(output, this.options.fileContext?.(worker.sessionId));
    streamMarkdown(output, live?.text ?? '', panel.querySelector<HTMLElement>('.architect-panel-scroll')!);
    let actions = panel.querySelector<HTMLElement>('.architect-live-actions');
    if (!actions) { actions = document.createElement('div'); actions.className = 'architect-live-actions'; output.after(actions); }
    if (actions.dataset.sessionId !== worker.sessionId) { actions.innerHTML = messageActionsHtml(worker.sessionId, 'live', false); actions.dataset.sessionId = worker.sessionId; }
    actions.hidden = !live?.text;
    if (live?.text) panel.querySelector<HTMLElement>('.architect-worker-empty')!.textContent = '';
    const tools = panel.querySelector<HTMLElement>('.architect-worker-tools')!;
    const history = panel.querySelector<HTMLElement>('.architect-worker-history')!;
    if (this.paintedWorker !== worker.id) { tools.replaceChildren(); this.paintedTools.clear(); this.paintedWorker = worker.id; }
    for (const element of [...tools.children]) { const id = (element as HTMLElement).dataset.toolSlot!; if (!live?.tools.has(id)) { element.remove(); this.paintedTools.delete(id); } }
    for (const tool of live?.tools.values() ?? []) {
      const saved = [...history.children].find(element => (element as HTMLElement).dataset.savedToolId === tool.id) as HTMLElement | undefined;
      if (saved) {
        const open = saved.querySelector<HTMLDetailsElement>('details')?.open;
        if (this.paintedTools.get(tool.id) !== tool || saved.dataset.liveVersion !== 'true') {
          saved.innerHTML = renderToolActivity(tool, 'tool:' + tool.id); saved.dataset.liveVersion = 'true';
          if (open) saved.querySelector<HTMLDetailsElement>('details')!.open = true;
        }
        const duplicate = [...tools.children].find(element => (element as HTMLElement).dataset.toolSlot === tool.id); duplicate?.remove();
        this.paintedTools.set(tool.id, tool); continue;
      }
      if (this.paintedTools.get(tool.id) === tool) continue;
      let slot = [...tools.children].find(element => (element as HTMLElement).dataset.toolSlot === tool.id) as HTMLElement | undefined;
      const open = slot?.querySelector<HTMLDetailsElement>('details')?.open;
      if (!slot) { slot = document.createElement('div'); slot.dataset.toolSlot = tool.id; tools.append(slot); }
      slot.innerHTML = renderToolActivity(tool, 'tool:' + tool.id);
      if (open) slot.querySelector<HTMLDetailsElement>('details')!.open = true;
      this.paintedTools.set(tool.id, tool);
    }
    const approvals = panel.querySelector<HTMLElement>('.architect-worker-approvals')!;
    for (const element of [...approvals.children]) if (!live?.approvals.has((element as HTMLElement).dataset.requestId!)) element.remove();
    for (const [id, text] of live?.approvals ?? []) {
      if ([...approvals.children].some(el => (el as HTMLElement).dataset.requestId === id)) continue;
      const card = document.createElement('div'); card.className = 'approval-card'; card.dataset.requestId = id;
      card.innerHTML = `<strong>${t('Worker needs approval')}</strong><p>${escape(text)}</p><div><button class="secondary-button" type="button">${t('Deny')}</button><button class="primary-button" type="button">${t('Approve')}</button></div><small role="alert"></small>`;
      card.querySelectorAll<HTMLButtonElement>('button').forEach((button, index) => button.addEventListener('click', async () => {
        card.querySelectorAll('button').forEach(b => { b.disabled = true; });
        try { await call('respond_approval', { sessionId: worker.sessionId, requestId: id, approved: index === 1 }); live?.approvals.delete(id); card.remove(); }
        catch (error) { card.querySelector('small')!.textContent = String(error); card.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
      })); approvals.append(card);
    }
    const inputs = panel.querySelector<HTMLElement>('.architect-worker-inputs')!;
    for (const element of [...inputs.children]) if (![...(live?.inputs.values() ?? [])].some(input => input.element === element)) element.remove();
    for (const input of live?.inputs.values() ?? []) if (input.element.parentElement !== inputs) inputs.append(input.element);
  }
}
