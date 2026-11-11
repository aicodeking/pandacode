import './architect.css';
import { renderTurnChanges, captureChangeCards, restoreChangeCards } from './turn-changes';
import { call } from './bridge';
import { escape, icon, markdown, morph } from './dom';
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
import { LEAD_RETRY, teamActive, teamHeldUntil, type TeamConfig, type TeamSnapshot, type TeamWorker, type ModelSelection, type TeamLibrary, type TeamSetup } from './architect-types';
import { resetTime } from './usage-limit';
import { mountTeamProfiles } from './team-profiles';
import { infoMark } from './tooltip';
import { workerQueueReason } from './worker-scheduling';
import { Subagents } from './subagents';
import { WorkerList, approvalLabel, effortLabel, markScrollRegions, requestHtml, workerActive, workerState, workerWord } from './architect-worker-list';
import { TeamMessages } from './team-messages';
import { teamSignature } from './team-progress';
import { councilNotice, councilProgress, councilSeatIds, formatScore, seatVerdict } from './council';
import { councilSummaryHtml } from './council-panel';
import { renderCoordination } from './coordination-message';
import { bindMessageActions, messageActionsHtml } from './message-actions';
import type { AgentEvent, Message, MessagePage, Provider, ProviderId, ProviderModel, Session, ToolActivity } from './types';

type SetupOptions = {
  task: Session; team: TeamSnapshot | null; library: TeamLibrary; providers: Provider[];
  loadModels: (provider: ProviderId) => Promise<ProviderModel[]>;
  save: (config: TeamConfig | null, architect: ModelSelection, profileId: string | null) => Promise<void>;
};
const statusNames: Record<string, string> = { ready: 'Ready', running: 'Working', waiting: 'Waiting', paused: 'Paused', completed: 'Ready for review', failed: 'Needs attention', interrupted: 'Interrupted', queued: 'Queued', stopped: 'Stopped', parked: 'Waiting on sub-workers' };
const modelName = (selection: ModelSelection, providers: Provider[]) => providers.find(p => p.id === selection.provider)?.models.find(m => m.id === selection.model)?.name ?? fallbackModel(selection.provider, selection.model || 'default').name;
const modelMarkup = (selection: ModelSelection, providers: Provider[]) => `<span class="provider-small ${escape(selection.provider)}">${providerLogo(selection.provider)}</span><span>${escape(modelName(selection, providers))}${selection.reasoningEffort ? `<small> · ${escape(selection.reasoningEffort)}</small>` : ''}</span>${icon('down')}`;

type SetupController = (() => void) & { hasChildMenu: () => boolean };

/** A lightweight, anchored editor. The task remains usable without a modal scrim. */
export function openArchitectSetup(anchor: HTMLElement, load: () => Promise<SetupOptions>, onClose: () => void): () => void {
  const panel = document.createElement('section');
  panel.className = 'architect-setup-popover floating-menu';
  panel.id = `team-setup-${crypto.randomUUID()}`;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Architect & workers');
  panel.tabIndex = -1;
  panel.innerHTML = `<header class="architect-setup-heading"><h2>Architect & workers</h2><button type="button" class="icon-button" aria-label="Close dialog">${icon('close')}</button></header><div class="architect-setup-scroll"><div id="architect-setup-host"><p class="architect-loading" role="status">Loading team setup…</p></div></div>`;
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
  const config: TeamConfig = structuredClone(source && !source.auto ? source : { workers: [{ id: 'worker-1', name: 'Worker 1', provider: workerProvider?.id ?? task.provider, model: '', reasoningEffort: null }], maxParallel: 0, maxRounds: 8, maxAssignments: 24, workspace: 'shared', summaryLimit: 3072 });
  // Council belongs to the task (`architect_set_council`): a saved setup must not start new tasks with it on.
  delete config.council;
  const architect: ModelSelection = team?.pendingSetup ? structuredClone(team.pendingSetup.architect) : !team && library.lastSetup && !task.resumeId ? structuredClone(library.lastSetup.architect) : { provider: task.provider, model: task.model, reasoningEffort: task.reasoningEffort ?? null };
  let disposed = false, pending = false, picker: (() => void) | undefined;
  const canDisable = Boolean(team) && !teamActive(team) && !team?.workers.length && !team?.round;
  const setupHelp = 'Applies to the next architect turn. Existing workers keep their models.';
  const parallelHelp = 'Maximum simultaneous assignments. The architect dispatches independent work; overlapping writes or dependencies may wait.';
  const guidanceHelp = 'Extra instructions for the lead, added to the built-in architect rules and sent with them. Leave it empty to use the guidance from Settings → Agent teams, or the built-in rules alone when none is set.';
  host.innerHTML = `<form class="architect-setup"><section class="architect-config-section"><div class="architect-section-label"><h3>Architect</h3><span>Plans & reviews</span></div><button class="architect-model" type="button" aria-label="Choose architect model" aria-haspopup="dialog" aria-expanded="false">${modelMarkup(architect, providers)}</button><div class="architect-guidance"><label for="team-guidance">Lead guidance</label>${infoMark(guidanceHelp, 'Lead guidance')}<span class="sr-only" id="team-guidance-help">${escape(guidanceHelp)}</span><textarea id="team-guidance" name="leadGuidance" rows="3" aria-describedby="team-guidance-help" placeholder="Extra instructions for the lead, on top of the built-in team rules.">${escape(config.leadGuidance ?? '')}</textarea><button type="button" class="secondary-button architect-guidance-reset">Reset to default</button></div></section><section class="architect-config-section"><div class="architect-section-label"><h3>Workers</h3><button type="button" class="architect-add" aria-label="Add worker profile">${icon('plus')} Add</button></div><div class="architect-profiles"></div></section><section class="architect-parallel"><div class="architect-parallel-controls"><label for="team-parallel">At once</label>${infoMark(parallelHelp, 'How parallel workers run')}<span id="team-parallel-help" class="sr-only">${parallelHelp}</span></div><div class="architect-parallel-controls"><label><input id="team-unlimited" type="checkbox" aria-label="Unlimited workers" aria-describedby="team-parallel-help" ${config.maxParallel === 0 ? 'checked' : ''}>Unlimited</label><input id="team-parallel" name="maxParallel" aria-label="Workers at once" aria-describedby="team-parallel-help" type="number" min="1" step="1" value="${config.maxParallel || 3}" ${config.maxParallel === 0 ? 'hidden' : ''} ${config.maxParallel === 0 ? 'disabled' : ''} required></div></section><p class="architect-workspace-note"><span class="architect-workspace-line">Write scopes decide who edits what; overlaps wait.</span><span class="architect-workspace-line">Workers have full access; approvals are automatic (deploy and scheduling go back to the lead).</span></p>${task.resumeId && !team ? '<p class="architect-workspace-note">A fresh architect context enables delegation. Your saved conversation stays here.</p>' : ''}${team ? `<p class="architect-workspace-note">Next architect turn ${infoMark(setupHelp, 'When team changes apply')}<span class="sr-only">${setupHelp}</span></p>` : ''}<p class="architect-setup-error" role="alert" hidden></p><div class="architect-setup-footer">${canDisable ? '<button class="secondary-button architect-disable" type="button">Use a single agent</button>' : '<span>Remembered for new tasks</span>'}<button class="primary-button" type="submit">${team && !canDisable ? 'Apply setup' : 'Save setup'}</button></div></form>`;
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
    config.leadGuidance = guidanceField.value.trim() || null;
    return structuredClone({ architect, config });
  }
  const savedProfiles = mountTeamProfiles(libraryHost, { library, pendingSetup: team?.pendingSetup, read: readSetup, busy: setBusy,
    apply: setup => {
      if (!team && task.resumeId && setup.architect.provider !== task.provider) throw new Error('Use a new task to switch the architect harness.');
      picker?.(); Object.assign(config, structuredClone(setup.config)); Object.assign(architect, structuredClone(setup.architect));
      renderProfiles(); refreshModelLabels();
      guidanceField.value = config.leadGuidance ?? '';
      parallel.value = String(config.maxParallel || 3); refreshParallel();
      error.hidden = true;
    },
  });
  form.addEventListener('input', () => savedProfiles.changed());
  host.querySelector<HTMLButtonElement>('.architect-guidance-reset')!.addEventListener('click', () => { guidanceField.value = ''; guidanceField.focus(); savedProfiles.changed(); });
  function choose(anchor: HTMLButtonElement, selection: ModelSelection, canSwitchProvider: boolean): void {
    picker?.();
    picker = openModelPicker({ anchor, providers, current: { ...selection, model: selection.model || 'default' }, canSwitchProvider, loadModels: options.loadModels,
      onSelect: async (provider, model) => { selection.provider = provider; selection.model = model; selection.reasoningEffort = null; anchor.innerHTML = modelMarkup(selection, providers); savedProfiles.changed(); },
      onEffortSelect: async effort => { selection.reasoningEffort = effort; anchor.innerHTML = modelMarkup(selection, providers); savedProfiles.changed(); },
      onClose: () => { picker = undefined; },
    });
  }
  function renderProfiles(): void {
    profiles.innerHTML = config.workers.map((profile, index) => `<div class="architect-profile" data-profile-id="${escape(profile.id)}"><div class="architect-profile-heading"><span class="architect-profile-number">${index + 1}</span><input aria-label="Worker profile ${index + 1} name" maxlength="60" value="${escape(profile.name)}"><button type="button" class="icon-button" aria-label="Remove worker profile ${index + 1}" ${config.workers.length === 1 ? 'disabled' : ''}>${icon('close')}</button></div><button type="button" class="architect-model" aria-label="Choose model for worker ${index + 1}" aria-haspopup="dialog" aria-expanded="false">${modelMarkup(profile, providers)}</button></div>`).join('');
    profiles.querySelectorAll<HTMLElement>('.architect-profile').forEach((row, index) => {
      row.querySelector('input')!.addEventListener('input', event => { config.workers[index].name = (event.target as HTMLInputElement).value; });
      row.querySelector('.icon-button')!.addEventListener('click', () => { picker?.(); config.workers.splice(index, 1); renderProfiles(); savedProfiles.changed(); });
      row.querySelector<HTMLButtonElement>('.architect-model')!.addEventListener('click', event => choose(event.currentTarget as HTMLButtonElement, config.workers[index], true));
    });
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
    picker?.(); config.workers.push({ ...config.workers[config.workers.length - 1], id: crypto.randomUUID(), name: `Worker ${config.workers.length + 1}` }); renderProfiles(); savedProfiles.changed();
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
    config.leadGuidance = guidanceField.value.trim() || null;
    if (!disable && !unlimited.checked && (!Number.isSafeInteger(config.maxParallel) || config.maxParallel < 1)) { error.textContent = 'Choose a whole worker count or Unlimited.'; error.hidden = false; return; }
    if (!disable && config.workers.some(p => !p.name.trim())) { error.textContent = 'Give each worker profile a name.'; error.hidden = false; return; }
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
/** Whether the reader dismissed the full-access note for a team this session (session storage; unavailable counts as no). */
const accessKey = (taskId: string) => `pandacode.workers-access-dismissed.${taskId}`;
const accessDismissed = (taskId: string): boolean => { try { return sessionStorage.getItem(accessKey(taskId)) === '1'; } catch { return false; } };
const dismissAccess = (taskId: string): void => { try { sessionStorage.setItem(accessKey(taskId), '1'); } catch { /* storage off: the note stays */ } };
/** A mirror's host cut text, files or rows of its reply to fit. */
const teamCut = (team: TeamSnapshot & { truncated?: boolean; workersTruncated?: boolean }) =>
  Boolean(team.truncated || team.workersTruncated || team.workers.some(worker => (worker as { filesTruncated?: boolean }).filesTruncated));

/** The selected worker is painted per frame. Background workers keep bounded data only. */
export class ArchitectView {
  readonly host = document.createElement('div');
  private trigger = document.createElement('button');
  private taskId = '';
  private team: TeamSnapshot | null = null;
  private panel?: HTMLElement;
  private selected = '';
  private returnFocus: HTMLElement | undefined;
  private live = new Map<string, WorkerLive>();
  /** The open panel's worker list (rows, tally, keyboard focus); src/architect-worker-list.ts. */
  private list?: WorkerList;
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
  constructor(private options: { setup: (anchor: HTMLElement) => void; loadModels: (provider: ProviderId) => Promise<ProviderModel[]>; updated: (team: TeamSnapshot) => void; report: (error: unknown) => void; onFork?: (sessionId: string, messageId: number) => Promise<void>; fileContext?: (sessionId: string) => FileLinkContext | undefined; assist?: (sessionId: string, kind: 'review' | 'route') => void; remote?: (sessionId: string) => boolean; leadMode?: (sessionId: string) => string | null }) {
    this.host.className = 'architect-host'; this.host.hidden = true;
    this.trigger.className = 'architect-trigger'; this.trigger.type = 'button'; this.trigger.setAttribute('aria-label', 'Open workers'); this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.addEventListener('click', () => this.panel ? this.close() : this.open()); this.host.append(this.trigger);
    this.host.addEventListener('keydown', event => { if (event.key === 'Escape' && this.panel) { event.preventDefault(); event.stopPropagation(); this.closeAndReturn(); } });
    bindMessageActions(this.host, {
      // A team on another computer has its workers' messages only as loaded from the host.
      content: (sessionId, key) => key === 'live' ? this.live.get(sessionId)?.text : this.options.remote?.(this.taskId) ? (this.historyWorker === sessionId ? this.historyMessages.get(Number(key))?.content : undefined) : call<string>('get_message_content', {sessionId, messageId: Number(key)}),
      onFork: options.onFork, report: options.report,
    });
  }
  setAssistEnabled(enabled: boolean): void { this.assistEnabled = enabled; this.paintAssist(); }
  private paintAssist(): void {
    const button = this.panel?.querySelector<HTMLButtonElement>('.architect-assist'); if (!button) return;
    button.hidden = !this.assistEnabled || !this.options.assist || Boolean(this.options.remote?.(this.taskId));
    button.textContent = this.selected ? 'Review with Jev' : 'Suggest worker';
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
      this.childAgents?.runEnded(event.sessionId);
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
  /** A worker is waiting on the user: an unanswered question, or an approval. Current hosts auto-grant worker
   *  approvals (turning each into `approval_cancelled`) and clear any they cannot; an older or unusual host can still
   *  forward a pending one. */
  needsInput(sessionId: string): boolean { const live = this.live.get(sessionId); return this.workerActive(sessionId) && Boolean(live?.approvals.size || live?.inputs.size); }
  /** A worker approval waiting for the user. Current hosts never leave one pending (they auto-grant it, or clear it
   *  once the worker's run is gone), but an older or unusual host can still forward one. */
  needsApproval(sessionId: string): boolean { return this.workerActive(sessionId) && Boolean(this.live.get(sessionId)?.approvals.size); }
  /** A request can only be the user's while its worker is still at work: never for a skipped or settled worker. */
  private workerActive(sessionId: string): boolean { return workerActive(this.team?.workers.find(member => member.sessionId === sessionId)); }
  private worker(): TeamWorker | undefined { return this.team?.workers.find(w => w.id === this.selected); }
  /** The lead's approval mode changed: repaint so the full-access note follows it. */
  modeChanged(): void { if (this.panel) this.schedulePaint(); }
  private schedulePaint(): void { this.paintFrame ||= requestAnimationFrame(() => { this.paintFrame = 0; this.paint(); }); }
  private schedule(): void { if (this.frame || !this.panel) return; this.frame = requestAnimationFrame(() => { this.frame = 0; this.paintLive(); }); }
  /** For the dock's Agents item: whether a team exists, how many workers run, and the panel. */
  get present(): boolean { return Boolean(this.team); }
  get running(): number { return this.team?.workers.filter(worker => worker.status === 'running').length ?? 0; }
  get isOpen(): boolean { return Boolean(this.panel); }
  open(focus = true): void {
    if (!this.team || this.panel) return;
    this.childAgents?.setTask('', false);
    const panel = document.createElement('section'); panel.className = 'architect-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Workers');
    panel.innerHTML = `<div class="architect-panel-heading"><button class="icon-button architect-back" aria-label="Back to workers" hidden>${icon('back')}</button><strong class="architect-panel-summary"></strong><small class="architect-panel-count"></small><span class="architect-panel-controls"><button class="icon-button" data-team-control="pause" aria-label="Pause team" title="Pause team">${icon('pause')}</button><button class="icon-button" data-team-control="resume" aria-label="Resume team" title="Resume team">${icon('play')}</button><button class="icon-button" data-team-control="stop" aria-label="Stop team" title="Stop team">${icon('stop')}</button><button class="icon-button architect-configure" aria-label="View team setup" title="Team setup">${icon('settings')}</button></span><button class="icon-button architect-close" aria-label="Close workers" title="Close">${icon('close')}</button></div><p class="architect-panel-error" role="status" hidden></p><span class="sr-only architect-panel-live" aria-live="polite"></span><div class="architect-panel-tally" hidden><span class="architect-panel-tally-text"></span><span class="sr-only architect-panel-tally-readable"></span><span class="architect-panel-tally-measure" aria-hidden="true" inert></span><span class="architect-progress" role="progressbar" aria-label="Workers finished" aria-valuemin="0"><span class="architect-progress-fill"></span></span></div><p class="architect-panel-tally-hidden" id="architect-tally-hidden" hidden></p><p class="architect-panel-access" title="Approvals are granted under the lead's authority, whatever its own mode. Deploy and scheduling tools are the exception: they are declined, and the worker hands them back to the lead." hidden><span class="architect-panel-access-icon" data-state-tone="worker-idle" aria-hidden="true">${icon('unlock')}</span><span class="architect-panel-access-text">Workers have full access; approvals are automatic.<span class="sr-only"> Deploy and scheduling tools are the exception: they are declined, and the worker hands them back to the lead.</span></span><button type="button" class="icon-button architect-panel-access-dismiss" aria-label="Dismiss the full-access note" title="Dismiss">${icon('close')}</button></p><div class="architect-panel-scroll"><div class="council-slot"></div><div class="architect-worker-list" aria-label="Workers" aria-describedby="architect-workers-hint"></div><span class="sr-only" id="architect-workers-hint">Up and down arrows move between workers; Home and End jump to the first and last. Right arrow shows details, left arrow hides them, Enter opens the transcript.</span><div class="architect-worker-detail" hidden><div class="architect-worker-meta"></div><details class="architect-assignment"><summary>Assignment & file scope</summary><p></p><small></small></details><details class="architect-worker-checkpoint" hidden><summary>Latest checkpoint <time></time></summary><dl><div><dt>Progress</dt><dd data-checkpoint="summary"></dd></div><div><dt>Next</dt><dd data-checkpoint="nextSteps"></dd></div><div class="architect-checkpoint-blocker"><dt>Blocked</dt><dd data-checkpoint="blocker"></dd></div></dl></details><div class="architect-worker-history"></div><div class="architect-worker-live"></div><div class="architect-worker-tools"></div><div class="architect-worker-approvals"></div><div class="architect-worker-inputs"></div><p class="architect-worker-empty" role="status"></p><button class="secondary-button architect-history-retry" hidden>Retry loading worker</button></div></div><p class="architect-worker-keyhint" aria-hidden="true">→ details · Enter opens</p>`;
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
    this.list = new WorkerList(panel, {
      needsInput: sessionId => this.needsInput(sessionId),
      needsApproval: sessionId => this.needsApproval(sessionId),
      modelName: worker => modelName(worker, this.providers),
      openWorker: workerId => { this.selected = workerId; this.paint(); this.revealApproval(); void this.loadMessages().then(() => this.revealApproval()); },
    });
    panel.querySelector('.architect-close')!.addEventListener('click', () => this.closeAndReturn());
    // The full-access note can be dismissed for this team (remembered for the session) to save a line.
    panel.querySelector('.architect-panel-access-dismiss')!.addEventListener('click', () => {
      dismissAccess(this.taskId); this.paint(); panel.querySelector<HTMLElement>('.architect-close')!.focus();
    });
    panel.querySelector('.architect-back')!.addEventListener('click', () => {
      const from = this.selected;
      this.selected = ''; this.historyWorker = ''; this.historyLoading = false; this.historyRefreshQueued = false; ++this.request; this.paint();
      // Back where it came from: the worker's row, or its reviewer row in the Council summary.
      const id = CSS.escape(from), list = this.panel?.querySelector<HTMLElement>(`.architect-worker-row[data-worker-id="${id}"], .council-summary .council-row[data-id="${id}"]`);
      (list?.offsetParent ? list : this.panel?.querySelector<HTMLElement>('.architect-close'))?.focus({ preventScroll: true });
    });
    panel.querySelector('.architect-configure')!.addEventListener('click', event => this.options.setup(event.currentTarget as HTMLElement));
    panel.querySelectorAll<HTMLButtonElement>('[data-team-control]').forEach(control => control.addEventListener('click', () => { void this.control(control.dataset.teamControl!); }));
    panel.querySelector('.architect-history-retry')!.addEventListener('click', () => { void this.loadMessages(); });
    const scroll = panel.querySelector<HTMLElement>('.architect-panel-scroll')!;
    scroll.addEventListener('scroll', () => { if (scroll.scrollTop < 72) void this.loadMessages(true); else if (this.historyTrimmedNewer && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 72) void this.loadMessages(); }, { passive: true });
    scroll.addEventListener('wheel', event => { if (event.deltaY < 0 && scroll.scrollTop < 72) void this.loadMessages(true); }, { passive: true });
    void Promise.allSettled([...new Set(this.team.config.workers.map(worker => worker.provider))].map(this.options.loadModels)).then(() => { if (this.panel === panel) this.paint(); });
    this.trigger.setAttribute('aria-expanded', 'true'); this.paint(); showPopover(panel, this.trigger);
    // The tally is fitted to the panel's width, known once it is laid out.
    requestAnimationFrame(() => { if (this.panel === panel) this.paint(); }); if (focus) panel.querySelector<HTMLButtonElement>('.architect-close')!.focus();
  }
  /** Closes the panel and returns focus where it came from: a reviewer row opened from the thread, else the trigger. */
  private closeAndReturn(): void {
    const back = this.returnFocus;
    this.close(); if (!back?.isConnected) this.trigger.focus({ preventScroll: true });
  }
  /** `from`: the row in the thread that opened the worker, for focus to return to when the panel closes. */
  async openWorker(workerId: string, subagentId?: string, from?: HTMLElement): Promise<void> {
    this.returnFocus = from && !this.panel?.contains(from) ? from : this.returnFocus;
    const worker = this.team?.workers.find(worker => worker.id === workerId);
    if (!worker) throw new Error('This worker is no longer available.');
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
    // Focus goes into the flyout, as from its own rows. Opened from the thread, its container shows a frame later.
    const back = () => this.panel?.querySelector<HTMLButtonElement>('.architect-back');
    back()?.focus();
    if (document.activeElement !== back()) requestAnimationFrame(() => { if (this.selected === workerId) back()?.focus(); });
    this.revealApproval();
    await this.loadMessages();
    this.revealApproval();
  }
  close(): void {
    // Closed with focus inside (Escape, the close button, or the dock's own Escape, which then focuses its item): a reviewer
    // opened from the thread gets focus back, after whoever closed us has placed it.
    const back = this.returnFocus, inside = Boolean(this.panel?.contains(document.activeElement));
    this.returnFocus = undefined;
    if (back?.isConnected && inside) queueMicrotask(() => { if (back.isConnected) back.focus({ preventScroll: true }); });
    this.teamMessages?.destroy(); this.teamMessages = undefined; this.childAgents?.setTask('', false); if (this.panel) hidePopover(this.panel); this.panel = undefined; this.selected = ''; this.list?.dispose(); this.list = undefined; this.paintedTools.clear(); this.paintedWorker = ''; this.historyWorker = ''; this.historyMessages.clear(); this.historyHasOlder = false; this.historyTrimmedNewer = false; this.historyLoading = false; this.historyRefreshQueued = false; this.request++; cancelAnimationFrame(this.frame); this.frame = 0; this.trigger.setAttribute('aria-expanded', 'false'); }
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
    const asking = team.workers.some(w => !w.abandoned && this.needsInput(w.sessionId));
    const progress = asking ? 'Needs you' : team.workers.length ? `${done}/${team.workers.length}` : 'Ready';
    const trigger = `${icon('team')}<span>Architect & workers</span><small>${progress}</small>${icon('chevron')}`;
    if (this.trigger.dataset.painted !== trigger) { this.trigger.innerHTML = trigger; this.trigger.dataset.painted = trigger; }
    this.trigger.dataset.status = asking ? 'waiting' : team.status;
    if (!this.panel) return;
    const panel = this.panel, worker = this.worker();
    this.paintAssist();
    // Auto teams have nothing to set up: the lead picks worker models.
    const remote = Boolean(this.options.remote?.(this.taskId));
    panel.querySelector<HTMLElement>('.architect-configure')!.hidden = Boolean(team.config.auto) || remote;
    const heldUntil = teamHeldUntil(team);
    // Asking, the header says so generically: the Council card below names Council and its state.
    panel.querySelector<HTMLElement>('.architect-panel-summary')!.textContent = heldUntil ? `Usage limit, resumes at ${resetTime(heldUntil)}` : team.councilStatus?.state === 'asking' ? 'Waiting for you' : teamActive(team) ? 'Architect is working…' : statusNames[team.status];
    const count = panel.querySelector<HTMLElement>('.architect-panel-count')!;
    count.textContent = `${team.workers.length} ${team.workers.length === 1 ? 'task' : 'tasks'}`; count.title = `Round ${team.round}`;
    // The list's tally already counts the workers.
    count.hidden = Boolean(team.workers.length) && !worker;
    panel.querySelector<HTMLButtonElement>('[data-team-control=pause]')!.hidden = !teamActive(team) || remote;
    panel.querySelector<HTMLButtonElement>('[data-team-control=stop]')!.hidden = remote || (!teamActive(team) && team.status !== 'paused');
    const resumable = ['paused', 'failed', 'interrupted'].includes(team.status);
    panel.querySelector<HTMLButtonElement>('[data-team-control=resume]')!.hidden = !resumable;
    panel.querySelectorAll<HTMLButtonElement>('[data-team-control]').forEach(button => { button.disabled = this.busy; });
    // Teams running on another computer are shown read-only, except that a stopped one can be resumed.
    panel.querySelector<HTMLElement>('.architect-panel-controls')!.hidden = remote && !resumable;
    // While held, the summary says when the retry goes; the note would only repeat it.
    // A Council refusal is written for the lead: the user reads plain words, as a notice.
    const notice = councilNotice(team);
    // The Council card shows its notice; the error line does not repeat it.
    const notes = [heldUntil && team.error && LEAD_RETRY.test(team.error) ? '' : notice ? (team.config.council ? '' : notice) : team.error, teamCut(team) && 'Some agent details were left out to fit. Open this task on the other computer to see them.', remote && 'Messages between teammates stay on the other computer.'].filter(Boolean);
    const error = panel.querySelector<HTMLElement>('.architect-panel-error')!; error.textContent = notes.join(' '); error.hidden = !notes.length;
    // Pausing or stopping is the user's own choice, and neither a quiet lead nor one retrying is a failure.
    error.classList.toggle('is-notice', !team.error || Boolean(notice) || (team.status === 'paused' && /^Team (paused|stopped)\./.test(team.error)) || /^The lead is quiet:/.test(team.error) || LEAD_RETRY.test(team.error));
    panel.querySelector<HTMLElement>('.architect-back')!.hidden = !worker;
    // Workers always run with full access and auto-approval, whatever the lead's mode: say so quietly when the lead
    // itself is not in Full access.
    const leadMode = this.taskId ? this.options.leadMode?.(this.taskId) ?? null : null;
    const access = panel.querySelector<HTMLElement>('.architect-panel-access')!;
    // Like the tally, it belongs to the list: hidden while a worker's transcript is open. It is also hidden while an
    // approval (forwarded by an older or unusual host) waits on the user, which it would contradict.
    const approvalPending = team.workers.some(member => this.needsApproval(member.sessionId));
    const hideAccess = !leadMode || leadMode === 'full' || !team.workers.length || Boolean(worker) || approvalPending || accessDismissed(this.taskId);
    if (access.hidden !== hideAccess) access.hidden = hideAccess;
    panel.querySelector<HTMLElement>('.architect-worker-list')!.hidden = Boolean(worker);
    if (worker) { panel.querySelector<HTMLElement>('.architect-panel-tally')!.hidden = true; panel.querySelector<HTMLElement>('.architect-panel-tally-hidden')!.hidden = true; }
    const councilSlot = panel.querySelector<HTMLElement>('.council-slot')!;
    councilSlot.hidden = Boolean(worker);
    // Council's state line and reviewer rows; its actions live in the composer's strip.
    if (!worker) morph(councilSlot, councilSummaryHtml(team));
    panel.querySelector<HTMLElement>('.architect-worker-detail')!.hidden = !worker;
    if (this.teamMessages) { this.teamMessages.host.hidden = Boolean(worker); if (!worker) this.teamMessages.update(team); }
    // Needs-you and failed changes are announced with a transcript open too.
    if (worker) this.list?.announce(team);
    if (worker) {
      const meta = panel.querySelector<HTMLElement>('.architect-worker-meta')!;
      const queueReason = workerQueueReason(worker, team.workers, team.config.maxParallel);
      meta.innerHTML = `${providerLogo(worker.provider)}<div class="architect-worker-copy"><strong>${escape(worker.name)}</strong><small>${escape([modelName(worker, this.providers), worker.reasoningEffort ? `${effortLabel(worker.reasoningEffort)}${worker.note ? ' (adjusted)' : ''}` : '', workerWord(worker, workerState(worker, team), this.needsApproval(worker.sessionId), this.needsInput(worker.sessionId)).full, worker.readOnly ? 'Read only' : ''].filter(Boolean).join(' · '))}</small>${queueReason ? `<small class="architect-worker-queue" role="status" data-tip="${escape(queueReason)}">${escape(queueReason)}</small>` : ''}${worker.error ? `<small class="architect-worker-error" role="status">${escape(worker.error)}</small>` : ''}</div>`;
      panel.querySelector<HTMLElement>('.architect-assignment p')!.textContent = worker.assignment;
      panel.querySelector<HTMLElement>('.architect-assignment small')!.textContent = worker.readOnly ? 'Read only · no writes' : worker.files.length ? `Write scope: ${worker.files.join(', ')}` : 'Write scope: shared checkout';
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
    // Reviewers of the current Council cycle are rows in the Council summary above, not in the list.
    const seated = councilSeatIds(councilProgress(team));
    this.list?.paint(seated.size ? { ...team, workers: team.workers.filter(worker => !seated.has(worker.id)) } : team, false, seated.size > 0);
  }
  /** Brings a failed auto-approval into view in an open transcript, and focuses it. */
  private revealApproval(): void {
    const card = this.panel?.querySelector<HTMLElement>('.architect-worker-approvals .approval-card');
    if (!card) return;
    // Centred, so the transcript header above it is not half cut off.
    card.scrollIntoView({ block: 'center' }); card.focus({ preventScroll: true });
  }
  /** Answers a worker's approval from its transcript card (forwarded by an older or unusual host). */
  private async respondApproval(sessionId: string, requestId: string, approved: boolean, host: HTMLElement): Promise<void> {
    const buttons = host.querySelectorAll<HTMLButtonElement>('[data-approval], button');
    // Read before disabling: a disabled button drops focus to the page.
    const focused = host.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    buttons.forEach(button => { button.disabled = true; });
    try {
      await call('respond_approval', { sessionId, requestId, approved });
      this.live.get(sessionId)?.approvals.delete(requestId);
      // The answered request leaves; focus moves to its worker's row (or the transcript's back button), never to the page.
      if (focused) {
        const worker = this.team?.workers.find(worker => worker.sessionId === sessionId);
        if (this.selected) this.panel?.querySelector<HTMLElement>('.architect-back')?.focus({ preventScroll: true });
        else if (worker) this.list?.focusRow(worker.id);
      }
      host.remove(); this.paint(); this.paintLive();
    } catch (error) {
      // The reason is for the log; the reader gets a plain sentence.
      console.error('Could not answer the worker approval', { sessionId, requestId, approved, error });
      host.querySelector('small')!.textContent = 'Couldn’t send your answer. The worker may have stopped.';
      buttons.forEach(button => { button.disabled = false; });
      focused?.focus({ preventScroll: true });
    }
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
    if (initial) empty.textContent = 'Loading worker…';
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
        else { const label = document.createElement('small'); label.textContent = message.role === 'assistant' ? worker.name : message.role === 'user' ? 'Assignment' : 'Activity'; const body = document.createElement('div'); article.append(label, body); bindFileLinkContext(body, fileContext); void markdown(body, message.content, scroll);
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
      empty.textContent = !this.historyMessages.size && !live?.text ? worker.error || worker.summary || (worker.status === 'queued' ? '' : 'Waiting for the worker’s first response.') : '';
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
    const answerable = this.needsApproval(worker.sessionId);
    for (const element of [...approvals.children]) if (!answerable || !live?.approvals.has((element as HTMLElement).dataset.requestId!)) element.remove();
    // Never for a skipped or settled worker.
    for (const [id, text] of answerable ? live?.approvals ?? [] : []) {
      if ([...approvals.children].some(el => (el as HTMLElement).dataset.requestId === id)) continue;
      // Kept for older or unusual hosts, which can still forward a pending worker approval (current
      // hosts auto-grant or clear them); when one arrives, the decision is the user's.
      const card = document.createElement('div'); card.className = 'approval-card architect-needs-approval'; card.dataset.requestId = id;
      card.innerHTML = `<strong class="architect-worker-alert"><span class="architect-worker-alert-icon" data-state-tone="near">${icon('alert')}</span><span>Needs approval</span></strong><p class="architect-approval-reason">This worker’s host asked for your approval.</p>${requestHtml(text)}<div><button class="secondary-button" type="button">Deny</button><button class="primary-button" type="button">Approve</button></div><small role="alert"></small>`;
      card.tabIndex = -1; card.setAttribute('role', 'group'); card.setAttribute('aria-label', approvalLabel(text));
      card.querySelectorAll<HTMLButtonElement>('button').forEach((button, index) => button.addEventListener('click', () => { void this.respondApproval(worker.sessionId, id, index === 1, card); }));
      approvals.append(card); markScrollRegions(card);
    }
    const inputs = panel.querySelector<HTMLElement>('.architect-worker-inputs')!;
    for (const element of [...inputs.children]) if (![...(live?.inputs.values() ?? [])].some(input => input.element === element)) element.remove();
    for (const input of live?.inputs.values() ?? []) if (input.element.parentElement !== inputs) inputs.append(input.element);
  }
}
