import './command-center.css';
import { t } from './i18n.ts';
import { icon } from './dom';
import { usageHeatmap } from './usage-heatmap';

export interface GoalState {
  threadId: string;
  objective: string;
  status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}
export type GoalAction = { action: 'set'; objective: string; tokenBudget: number | null } | { action: 'pause' | 'resume' | 'clear' };
export interface CommandView { refresh(): Promise<void>; dispose(): void; }
interface GoalOptions {
  taskId: string;
  initialObjective?: string;
  load(): Promise<GoalState | null>;
  execute(action: GoalAction): Promise<GoalState | null>;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', content = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag); element.className = className; element.textContent = content; return element;
}
function button(label: string, className = 'secondary-button'): HTMLButtonElement {
  const element = node('button', className, label); element.type = 'button'; return element;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const goalLabels: Record<GoalState['status'], string> = { active: t('Working toward goal'), paused: t('Paused'), blocked: t('Needs attention'), usageLimited: t('Usage limit reached'), budgetLimited: t('Token budget reached'), complete: t('Goal completed') };
function goalUsage(goal: GoalState): string {
  const parts = [t`${number.format(goal.tokensUsed)}${goal.tokenBudget === null ? '' : ` / ${number.format(goal.tokenBudget)}`} tokens`];
  const seconds = Math.max(0, Math.floor(goal.timeUsedSeconds));
  if (seconds) parts.push(seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`);
  return parts.join(' · ');
}

/** Updates the same nodes for streamed goal events; there is no polling or synthetic progress. */
export function createGoalBanner(options: { open(): void; pause(): Promise<void>; resume(): Promise<void> }): {
  element: HTMLElement; update(goal: GoalState | null): void; dispose(): void;
} {
  const element = node('section', 'goal-banner'); element.hidden = true; element.setAttribute('aria-label', t('Task goal'));
  const open = button('', 'goal-banner-open'); open.setAttribute('aria-label', t('Manage task goal'));
  const symbol = node('span', 'goal-banner-symbol'); symbol.innerHTML = icon('spark');
  const copy = node('span', 'goal-banner-copy'), title = node('strong'), status = node('small'); copy.append(title, status); open.append(symbol, copy);
  const control = button(t('Pause'), 'goal-banner-control');
  const error = node('span', 'command-error'); error.hidden = true; error.setAttribute('role', 'alert');
  element.append(open, control, error);
  let current: GoalState | null = null, disposed = false;
  const pending = new Set<string>();
  function update(goal: GoalState | null): void {
    if (current?.threadId !== goal?.threadId) error.hidden = true;
    current = goal; element.hidden = !goal;
    if (!goal) return;
    element.dataset.status = goal.status;
    if (title.textContent !== goal.objective) title.textContent = goal.objective;
    const summary = `${goalLabels[goal.status]} · ${goalUsage(goal)}`;
    if (status.textContent !== summary) status.textContent = summary;
    control.hidden = !['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited'].includes(goal.status);
    control.textContent = pending.has(goal.threadId) ? t('Updating…') : goal.status === 'active' ? t('Pause') : t('Resume');
    control.setAttribute('aria-label', goal.status === 'active' ? t('Pause goal') : t('Resume goal')); control.disabled = pending.has(goal.threadId);
  }
  open.addEventListener('click', options.open);
  control.addEventListener('click', async () => {
    if (!current || disposed || pending.has(current.threadId)) return;
    const threadId = current.threadId;
    const action = current.status === 'active' ? options.pause : options.resume;
    pending.add(threadId); error.hidden = true; update(current);
    try { await action(); }
    catch (cause) { if (!disposed && current?.threadId === threadId) { error.textContent = message(cause); error.hidden = false; } }
    finally { pending.delete(threadId); if (!disposed) update(current); }
  });
  return { element, update, dispose() { disposed = true; current = null; pending.clear(); element.remove(); } };
}

function shell(dialog: HTMLDialogElement, title: string, description?: string) {
  const host = node('section', 'command-center');
  const header = node('header', 'command-center-heading'); const heading = node('h2', '', title);
  const close = button('', 'command-center-close'); close.innerHTML = icon('close'); close.setAttribute('aria-label', t('Close'));
  header.append(heading, close); host.append(header);
  if (description) host.append(node('p', 'command-description', description));
  const content = node('div', 'command-center-content');
  const error = node('p', 'command-error'); error.hidden = true; error.setAttribute('role', 'alert');
  const footer = node('footer', 'command-center-footer'); const refresh = button(t('Refresh')), done = button(t('Done'), 'primary-button');
  footer.append(refresh, done); host.append(content, error, footer);
  dialog.className = 'settings-dialog command-center-dialog'; dialog.replaceChildren(host); if (!dialog.open) dialog.showModal();
  let disposed = false;
  const live = () => !disposed && dialog.open && host.parentElement === dialog;
  const onClose = () => { disposed = true; dialog.removeEventListener('close', onClose); };
  dialog.addEventListener('close', onClose);
  close.addEventListener('click', () => { if (live()) dialog.close(); });
  done.addEventListener('click', () => { if (live()) dialog.close(); });
  return { host, content, error, footer, refresh, done, live,
    fail(cause: unknown) { if (live()) { error.textContent = message(cause); error.hidden = false; } },
    dispose() { onClose(); if (host.parentElement === dialog) host.remove(); },
  };
}

export function showGoalDialog(dialog: HTMLDialogElement, options: GoalOptions): CommandView {
  const view = shell(dialog, t('Goal'), t('Keep working across turns until the objective is reached, paused, or a limit is reached.'));
  view.host.dataset.taskId = options.taskId;
  const status = node('div', 'goal-overview'); status.setAttribute('role', 'status'); status.textContent = t('Loading goal…');
  const form = node('form', 'goal-form');
  const fields = node('fieldset', 'command-fields');
  const objectiveLabel = node('label', 'command-field'); objectiveLabel.append(node('span', '', t('Objective')));
  const objective = node('textarea'); objective.rows = 3; objective.required = true; objective.maxLength = 16384; objective.placeholder = t('What should the agent accomplish?'); objective.setAttribute('aria-label', t('Goal objective')); objective.value = options.initialObjective ?? ''; objectiveLabel.append(objective);
  const budgetLabel = node('label', 'command-field'); budgetLabel.append(node('span', '', t('Token budget')), node('small', '', t('Optional. Leave blank for no token limit.')));
  const budget = node('input'); budget.type = 'number'; budget.min = '1'; budget.step = '1'; budget.max = String(Number.MAX_SAFE_INTEGER); budget.inputMode = 'numeric'; budget.placeholder = t('No limit'); budget.setAttribute('aria-label', t('Goal token budget')); budgetLabel.append(budget);
  fields.append(objectiveLabel, budgetLabel); form.append(fields);
  const actions = node('div', 'goal-actions'), save = button(t('Start goal'), 'primary-button'); save.type = 'submit';
  const pause = button(t('Pause')), resume = button(t('Resume')), clear = button(t('Clear goal'), 'command-text-button'); actions.append(clear, pause, resume, save); form.append(actions);
  view.content.append(status, form);
  let current: GoalState | null = null, loaded = false, pending = false, dirty = Boolean(options.initialObjective), revision = 0;
  objective.addEventListener('input', () => { dirty = true; }); budget.addEventListener('input', () => { dirty = true; });
  function update(goal: GoalState | null, fill: boolean): void {
    current = goal; status.dataset.status = goal?.status ?? 'none';
    status.replaceChildren(node('strong', '', goal ? goalLabels[goal.status] : t('No active goal')));
    if (goal) status.append(node('small', '', goalUsage(goal)));
    if (fill && !dirty) { objective.value = goal?.objective ?? options.initialObjective ?? ''; budget.value = goal?.tokenBudget == null ? '' : String(goal.tokenBudget); }
    fields.disabled = pending; save.disabled = !loaded || pending; view.refresh.disabled = pending;
    save.textContent = pending ? t('Updating…') : goal ? t('Save goal') : t('Start goal');
    pause.hidden = goal?.status !== 'active'; resume.hidden = !goal || !['paused', 'blocked', 'usageLimited', 'budgetLimited'].includes(goal.status); clear.hidden = !goal;
    for (const control of [pause, resume, clear]) control.disabled = pending || !loaded;
  }
  async function refresh(): Promise<void> {
    if (!view.live() || pending) return;
    const ticket = ++revision; view.refresh.disabled = true; view.error.hidden = true;
    try {
      const goal = await options.load();
      if (view.live() && ticket === revision) { loaded = true; update(goal, true); }
    } catch (cause) { if (ticket === revision) view.fail(cause); }
    finally { if (view.live() && ticket === revision) view.refresh.disabled = false; }
  }
  async function execute(action: GoalAction): Promise<void> {
    if (!view.live() || !loaded || pending) return;
    ++revision; pending = true; view.error.hidden = true; update(current, false);
    try {
      const goal = await options.execute(action);
      if (view.live()) { dirty = false; current = goal; update(goal, true); }
    } catch (cause) { view.fail(cause); }
    finally { pending = false; if (view.live()) update(current, false); }
  }
  form.addEventListener('submit', event => {
    event.preventDefault(); event.stopPropagation();
    if (!form.reportValidity()) return;
    const value = objective.value.trim();
    if (!value) { objective.focus(); view.fail(t('Enter an objective for the goal.')); return; }
    const tokens = budget.value === '' ? null : budget.valueAsNumber;
    if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 1)) { budget.focus(); view.fail(t('Enter a whole token budget greater than zero.')); return; }
    void execute({ action: 'set', objective: value, tokenBudget: tokens });
  });
  pause.addEventListener('click', () => { void execute({ action: 'pause' }); }); resume.addEventListener('click', () => { void execute({ action: 'resume' }); }); clear.addEventListener('click', () => { void execute({ action: 'clear' }); });
  view.refresh.addEventListener('click', () => { void refresh(); });
  update(null, false); void refresh();
  return { refresh, dispose() { ++revision; objective.value = ''; view.dispose(); } };
}

interface PanelBase { notes?: string[]; }
interface NamedItem { id: string; title: string; description?: string; source?: string; }
export type PreferenceField = { id: string; label: string; description?: string; value: boolean | string; disabled?: boolean } & (
  { type: 'toggle' } | { type: 'select'; options: { value: string; label: string }[] } | { type: 'text' }
);
export type CommandPanel = PanelBase & (
  | { kind: 'usage'; accountLabel?: string; plan?: string; windows: { id: string; label: string; usedPercent?: number | null; resetsAt?: number | null }[]; stats?: { label: string; value: string }[]; daily?: { date: string; tokens: number }[] }
  | { kind: 'jobs'; jobs: { id: string; title: string; status: string; detail?: string; canStop?: boolean }[] }
  | { kind: 'imports'; items: NamedItem[] }
  | { kind: 'conversations'; items: (NamedItem & { updatedAt?: number })[]; mode: 'resume' | 'fork' | 'import'; cursor?: string | null }
  | { kind: 'preferences'; fields: PreferenceField[] }
  | { kind: 'hooks'; items: (NamedItem & { enabled: boolean })[] }
  | { kind: 'plugins'; items: (NamedItem & { status: string })[] }
  | { kind: 'result'; title: string; description: string; status?: string }
);
export interface CommandCenterOptions {
  title: string;
  description?: string;
  initialSearch?: string;
  initialSection?: 'daily';
  load(cursor?: string): Promise<CommandPanel>;
  execute(action: string, payload: Record<string, unknown>): Promise<CommandPanel | void>;
}

export function showCommandCenter(dialog: HTMLDialogElement, options: CommandCenterOptions): CommandView {
  const view = shell(dialog, options.title, options.description);
  view.content.append(node('p', 'command-empty', t('Loading…')));
  let revision = 0, pending = false;
  const selected = new Set<string>(); let searchText = options.initialSearch ?? '';
  async function execute(action: string, payload: Record<string, unknown>): Promise<void> {
    if (!view.live() || pending) return;
    ++revision; pending = true; view.error.hidden = true; view.refresh.disabled = true;
    const controls = [...view.content.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')];
    const wasDisabled = controls.map(control => control.disabled); controls.forEach(control => { control.disabled = true; });
    try {
      const result = await options.execute(action, payload);
      if (!view.live()) return;
      if (result) render(result);
      else { const panel = await options.load(); if (view.live()) render(panel); }
    } catch (cause) { view.fail(cause); }
    finally {
      pending = false;
      if (view.live()) { view.refresh.disabled = false; controls.forEach((control, i) => { if (control.isConnected) control.disabled = wasDisabled[i]; }); }
    }
  }
  async function refresh(): Promise<void> {
    if (!view.live() || pending) return;
    const ticket = ++revision; view.refresh.disabled = true; view.error.hidden = true;
    try { const panel = await options.load(); if (view.live() && ticket === revision) render(panel); }
    catch (cause) { if (ticket === revision) view.fail(cause); }
    finally { if (view.live() && ticket === revision) view.refresh.disabled = false; }
  }
  function notes(panel: PanelBase): void { for (const note of panel.notes ?? []) view.content.append(node('p', 'command-note', note)); }
  function row(item: NamedItem): HTMLElement {
    const copy = node('div', 'command-row-copy'); copy.append(node('strong', '', item.title));
    if (item.description) copy.append(node('small', '', item.description));
    if (item.source) copy.append(node('span', 'command-source', item.source));
    return copy;
  }
  function render(panel: CommandPanel): void {
    view.content.replaceChildren(); view.content.dataset.kind = panel.kind;
    if (panel.kind === 'usage') {
      if (panel.accountLabel || panel.plan) view.content.append(node('p', 'command-account', [panel.accountLabel, panel.plan].filter(Boolean).join(' · ')));
      for (const window of panel.windows) {
        const group = node('div', 'command-usage-window'); const header = node('div', 'command-row');
        const valid = typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent);
        const consumed = valid ? Math.max(0, Math.min(100, window.usedPercent!)) : null;
        header.append(node('strong', '', window.label), node('span', '', consumed === null ? t('Unavailable') : t`${number.format(consumed)}% used`)); group.append(header);
        if (consumed !== null) { const progress = node('progress'); progress.max = 100; progress.value = consumed; progress.setAttribute('aria-label', t`${window.label} usage`); group.append(progress); }
        if (typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt)) { const when = new Date(window.resetsAt * 1000); if (Number.isFinite(when.getTime())) group.append(node('small', '', t`Resets ${when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`)); }
        view.content.append(group);
      }
      for (const stat of panel.stats ?? []) { const item = node('div', 'command-row'); item.append(node('span', '', stat.label), node('strong', '', stat.value)); view.content.append(item); }
      if (panel.daily?.length) {
        const activity = usageHeatmap(panel.daily); view.content.append(activity);
        if (options.initialSection === 'daily') requestAnimationFrame(() => { activity.scrollIntoView({ block: 'nearest' }); activity.querySelector<HTMLElement>('.heatmap')?.focus({ preventScroll: true }); });
      }
      if (!panel.windows.length && !panel.stats?.length) view.content.append(node('p', 'command-empty', t('No usage information is available.')));
    } else if (panel.kind === 'jobs') {
      if (!panel.jobs.length) view.content.append(node('p', 'command-empty', t('No background jobs are running.')));
      for (const job of panel.jobs) {
        const item = node('div', 'command-row command-job'); item.dataset.itemId = job.id;
        item.append(row({ id: job.id, title: job.title, description: job.detail }), node('span', 'command-status', job.status));
        if (job.canStop) { const stop = button(t('Stop')); stop.setAttribute('aria-label', t`Stop ${job.title}`); stop.addEventListener('click', () => { void execute('stop', { id: job.id }); }); item.append(stop); }
        view.content.append(item);
      }
    } else if (panel.kind === 'imports' || panel.kind === 'conversations') {
      const availableIds = new Set(panel.items.map(item => item.id)); for (const id of selected) if (!availableIds.has(id)) selected.delete(id);
      const search = node('input', 'command-search'); search.type = 'search'; search.placeholder = panel.kind === 'imports' ? t('Search available imports') : t('Search conversations'); search.setAttribute('aria-label', search.placeholder); search.value = searchText;
      const list = node('div', 'command-choice-list'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', panel.kind === 'imports' ? t('Available imports') : t('Available conversations'));
      const empty = node('p', 'command-empty', panel.items.length ? t('No matches.') : panel.kind === 'imports' ? t('No importable items were found.') : t('No conversations were found.'));
      const label = panel.kind === 'imports' ? t('Import selected') : panel.mode === 'fork' ? t('Fork conversation') : panel.mode === 'import' ? t('Import conversation') : t('Resume conversation');
      const commit = button(label, 'primary-button'); commit.disabled = !selected.size;
      const rows = panel.items.map(item => {
        const wrapper = node('label', 'command-choice'); wrapper.dataset.itemId = item.id;
        const input = node('input'); input.type = panel.kind === 'imports' ? 'checkbox' : 'radio'; input.name = 'command-choice'; input.value = item.id; input.checked = selected.has(item.id);
        input.addEventListener('change', () => { if (panel.kind === 'conversations') selected.clear(); if (input.checked) selected.add(item.id); else selected.delete(item.id); commit.disabled = !selected.size; });
        wrapper.append(input, row(item)); list.append(wrapper); return { wrapper, item };
      });
      const filter = () => { searchText = search.value; const query = searchText.trim().toLocaleLowerCase(); let visible = 0; for (const { wrapper, item } of rows) { wrapper.hidden = ![item.title, item.description, item.source].filter(Boolean).join(' ').toLocaleLowerCase().includes(query); if (!wrapper.hidden) visible++; } empty.hidden = visible > 0; };
      search.addEventListener('input', filter); filter();
      commit.addEventListener('click', () => { if (!selected.size) return; void execute(panel.kind === 'imports' ? 'import' : panel.mode, panel.kind === 'imports' ? { ids: [...selected] } : { id: [...selected][0] }); });
      view.content.append(search, list, empty, commit);
      if (panel.kind === 'conversations' && panel.cursor) {
        const more = button(t('Load more conversations'));
        more.addEventListener('click', async () => {
          if (pending) return;
          const ticket = ++revision; pending = true; more.disabled = true; view.refresh.disabled = true; view.error.hidden = true;
          try {
            const next = await options.load(panel.cursor!);
            if (view.live() && ticket === revision && next.kind === 'conversations') {
              const items = new Map([...panel.items, ...next.items].map(item => [item.id, item]));
              render({ ...next, mode: panel.mode, items: [...items.values()] });
            }
          } catch (cause) { if (ticket === revision) view.fail(cause); }
          finally { pending = false; if (view.live()) { view.refresh.disabled = false; more.disabled = false; } }
        });
        view.content.append(more);
      }
    } else if (panel.kind === 'preferences') {
      const form = node('form', 'command-preferences'); const fields = node('fieldset', 'command-fields');
      const readers: { id: string; initial: string | boolean; read(): string | boolean }[] = [];
      for (const field of panel.fields) {
        const label = node('label', `command-field${field.type === 'toggle' ? ' command-toggle-field' : ''}`); const copy = node('span'); copy.append(node('strong', '', field.label)); if (field.description) copy.append(node('small', '', field.description));
        const input = field.type === 'select' ? node('select') : node('input'); input.setAttribute('aria-label', field.label); input.disabled = Boolean(field.disabled);
        if (input instanceof HTMLSelectElement && field.type === 'select') { field.options.forEach(option => input.append(new Option(option.label, option.value))); input.value = String(field.value); }
        else if (input instanceof HTMLInputElement) { input.type = field.type === 'toggle' ? 'checkbox' : 'text'; if (field.type === 'toggle') input.checked = field.value === true; else { input.value = String(field.value); input.maxLength = 1024; input.autocomplete = 'off'; } }
        label.append(copy, input); fields.append(label);
        if (!field.disabled) readers.push({ id: field.id, initial: field.value, read: () => input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : input.value });
      }
      const save = button(t('Save changes'), 'primary-button'); save.type = 'submit'; save.disabled = true;
      form.addEventListener('input', () => { save.disabled = !readers.some(reader => reader.read() !== reader.initial); }); form.addEventListener('change', () => { save.disabled = !readers.some(reader => reader.read() !== reader.initial); });
      form.addEventListener('submit', event => { event.preventDefault(); event.stopPropagation(); if (!form.reportValidity()) return; const values = Object.fromEntries(readers.filter(reader => reader.read() !== reader.initial).map(reader => [reader.id, reader.read()])); if (Object.keys(values).length) void execute('set_preferences', { values }); });
      form.append(fields, save); view.content.append(form); if (!panel.fields.length) view.content.append(node('p', 'command-empty', t('No editable preferences are available.')));
    } else if (panel.kind === 'hooks' || panel.kind === 'plugins') {
      if (!panel.items.length) view.content.append(node('p', 'command-empty', panel.kind === 'hooks' ? t('No lifecycle hooks are configured.') : t('No plugins are installed.')));
      for (const item of panel.items) { const entry = node('div', 'command-row'); entry.append(row(item), node('span', 'command-status', 'enabled' in item ? item.enabled ? t('Enabled') : t('Disabled') : item.status)); view.content.append(entry); }
    } else if (panel.kind === 'result') {
      view.content.append(node('strong', 'command-result-title', panel.title), node('p', 'command-note', panel.description));
      if (panel.status) view.content.append(node('p', 'command-status', panel.status));
    }
    notes(panel);
  }
  view.refresh.addEventListener('click', () => { void refresh(); }); void refresh();
  return { refresh, dispose() { ++revision; selected.clear(); view.dispose(); } };
}
