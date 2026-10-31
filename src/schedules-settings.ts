/* Settings → Schedules: every wake-up and timed message across threads, the scheduler's switches,
 * an editor for custom schedules, a workflow builder that chains threads, and the recent runs.
 * The IPC contract is `schedules-api.ts`. */
import './schedules-settings.css';
import { call, subscribe } from './bridge';
import { escape, icon } from './dom';
import { openChoiceMenu } from './choice-menu';
import { trackSegment } from './motion';
import { infoMark } from './tooltip';
import { cadence, clockAt, clockTime, schedulesApi, when, SCHEDULES_CHANGED, type ScheduleInput, type ScheduleKind, type ScheduleRun, type SchedulerSettings, type TaskSchedule, isFinished } from './schedules-api';
import type { Project, Session } from './types';

export interface SchedulesSettingsOptions {
  intent?: { newForSession?: string; editScheduleId?: string };
  openThread(sessionId: string): void;
}

type Filter = 'all' | 'agent' | 'user' | 'paused';
type Start = 'now' | 'once' | 'daily' | 'weekdays' | 'after';
interface Step { sessionId: string; prompt: string }
const FILTERS: [Filter, string][] = [['all', 'All'], ['agent', 'Agents'], ['user', 'Yours'], ['paused', 'Paused']];
const KINDS: [ScheduleKind, string][] = [['once', 'Once'], ['interval', 'Repeat every'], ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly'], ['after', 'After a thread finishes']];
const STARTS: [Start, string][] = [['now', 'Now'], ['once', 'At a time'], ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['after', 'After a thread finishes']];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const REFRESH_MS = 30_000;
const SNOOZE_MINUTES = 60;
const LIMIT_MIN = 1, LIMIT_MAX = 50;
const INTERVAL_MIN = 5, INTERVAL_MAX = 7 * 24 * 60;
const STEPS_MIN = 2, STEPS_MAX = 6;
const TEMPLATES: { id: string; title: string; detail?: string; input?: Partial<ScheduleInput> }[] = [
  { id: 'standup', title: 'Morning standup summary', input: { title: 'Morning standup summary', prompt: 'Summarize what changed since yesterday, what is in progress and anything blocked.', kind: 'weekdays', timeOfDay: '09:00' } },
  { id: 'ci', title: 'Check CI every 30 min', input: { title: 'Check CI', prompt: 'Check whether CI passed on this branch and fix anything red.', kind: 'interval', intervalMinutes: 30 } },
  { id: 'after', title: 'Review when another thread finishes', detail: 'After a thread finishes', input: { title: 'Review the finished thread', prompt: 'Another thread just finished. Review its changes and report anything that needs attention.', kind: 'after', onlyOnSuccess: true } },
  { id: 'chain', title: 'Chain threads', detail: 'One step after another' },
];

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const pad = (value: number) => String(value).padStart(2, '0');
const localInput = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const quote = (text: string) => `“${text}”`;
const brief = (input: Partial<ScheduleInput>) => cadence({ kind: input.kind ?? 'once', intervalMinutes: input.intervalMinutes ?? null, timeOfDay: input.timeOfDay ?? null, days: input.days ?? [], watchSessionTitle: null, onlyOnSuccess: false });
const CLOCK_KINDS: ScheduleKind[] = ['daily', 'weekdays', 'weekly'];
/** "tomorrow" for "tomorrow 9:00 AM", when the row's cadence already says the time. */
const dayOnly = (at: number) => when(at).replace(clockAt(at), '').trim() || when(at);
const workflowName = (schedule: TaskSchedule) => schedule.title.split(' · ')[0] || 'Workflow';
const absolute = (at: number) => `${new Date(at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${clockAt(at)}`;

/** Next clock time for the editor's preview; the native scheduler computes the real one. */
function nextRun(input: ScheduleInput, now = Date.now()): number | null {
  if (input.kind === 'once') return input.runAt ?? null;
  if (input.kind === 'interval') return input.intervalMinutes ? now + input.intervalMinutes * 60_000 : null;
  if (input.kind === 'after' || !/^\d\d:\d\d$/.test(input.timeOfDay ?? '')) return null;
  const [h, m] = input.timeOfDay!.split(':').map(Number);
  const ok = (day: number) => input.kind === 'daily' || (input.kind === 'weekdays' ? day > 0 && day < 6 : (input.days ?? []).includes(day));
  for (let i = 0; i < 8; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i); d.setHours(h, m, 0, 0);
    if (d.getTime() > now && ok(d.getDay())) return d.getTime();
  }
  return null;
}

/** "every weekday at 9:00 AM", "after “Build” succeeds". */
function phrase(input: ScheduleInput, watchTitle: string | null): string {
  const at = input.timeOfDay ? clockTime(input.timeOfDay) : '';
  switch (input.kind) {
    case 'once': return input.runAt ? `once, ${absolute(input.runAt)}` : 'once';
    case 'daily': return `every day at ${at}`;
    case 'weekdays': return `every weekday at ${at}`;
    case 'weekly': return input.days?.length ? `every ${[...input.days].sort().map(day => DAYS[day]).join(', ')} at ${at}` : 'weekly (pick days)';
    case 'after': return watchTitle ? `${input.maxRuns === 1 ? 'the next time' : 'every time'} ${quote(watchTitle)} ${input.onlyOnSuccess ? 'succeeds' : 'finishes'}` : '· pick a thread to follow';
    default: return cadence({ kind: input.kind, intervalMinutes: input.intervalMinutes ?? null, timeOfDay: null, days: [], watchSessionTitle: null, onlyOnSuccess: false }).replace(/^\w/, c => c.toLowerCase());
  }
}

/** A workflow's steps in chain order: the step without a predecessor, then each step's successor. */
function stepsInOrder(steps: TaskSchedule[]): TaskSchedule[] {
  const ids = new Set(steps.map(step => step.id)), out: TaskSchedule[] = [];
  let current = steps.find(step => !step.chainFromId || !ids.has(step.chainFromId));
  while (current && !out.includes(current)) { out.push(current); const previous: TaskSchedule = current; current = steps.find(step => step.chainFromId === previous.id); }
  return [...out, ...steps.filter(step => !out.includes(step))];
}

const field = (label: string, control: string, cls = '') => `<label class="schedules-field ${cls}"><span>${label}</span>${control}</label>`;
const switchRow = (key: string, title: string, detail: string) =>
  `<div class="setting-row"><div><strong>${title}</strong>${infoMark(detail)}</div><input type="checkbox" class="settings-switch" data-setting="${key}" aria-label="${title}"></div>`;
const segmented = (cls: string, label: string, items: [string, string][], attr: string) =>
  `<div class="${cls} schedules-segmented" role="group" aria-label="${label}">${items.map(([id, text]) => `<button type="button" data-${attr}="${id}" aria-pressed="false">${text}</button>`).join('')}</div>`;

export function mountSchedulesSettings(host: HTMLElement, options: SchedulesSettingsOptions): () => void {
  host.innerHTML = `<div class="schedules">
    <p class="schedules-intro">Agents can wake their own thread later and send messages to other threads. You can set the same up here.${infoMark('A schedule sends a message to a thread once, on repeat, or after another thread finishes. A workflow chains threads: each step starts when the previous one ends. Agent-created schedules are tinted.', 'About schedules')}</p>
    <div class="settings-group">
      ${switchRow('agentsMaySchedule', 'Let agents schedule wake-ups', 'Agents get tools to wake their own thread later or send a timed message.')}
      ${switchRow('askBeforeMessagingOtherTasks', 'Ask before agents message other threads', 'An agent scheduling a message for another thread asks you first. Self wake-ups never ask.')}
      ${switchRow('paused', 'Pause all schedules', 'Holds every schedule without deleting it. Due runs and triggers wait until you resume.')}
      <div class="setting-row"><div><strong>Agent limit per thread</strong>${infoMark('Active agent-created schedules allowed on one thread.')}</div><input type="number" class="schedules-limit" min="${LIMIT_MIN}" max="${LIMIT_MAX}" step="1" aria-label="Agent limit per thread"></div>
    </div>
    <p class="schedules-paused" role="status" hidden>${icon('pause')}<span>Schedules are on hold. Nothing is lost: anything due, and any thread that finishes meanwhile, waits here and runs when you resume.</span><button type="button" class="secondary-button" data-resume-all>Resume all</button></p>
    <span id="schedules-held-note" hidden>Paused for all schedules</span>
    <div class="settings-heading schedules-heading"><h3>Upcoming</h3>${segmented('schedules-filter', 'Show schedules', FILTERS, 'filter')}<button type="button" class="secondary-button schedules-new-workflow">${icon('branch')}New workflow</button><button type="button" class="secondary-button schedules-new">${icon('plus')}New schedule</button></div>
    <form class="schedules-editor schedules-card" aria-label="Schedule" novalidate hidden>
      ${field('Thread', '<select class="schedules-thread" aria-label="Thread"></select>')}
      ${field('Title', '<input type="text" class="schedules-title" maxlength="120" autocomplete="off" aria-label="Title" placeholder="Optional; the message’s first words otherwise">')}
      ${field('Message', '<textarea class="schedules-message" rows="3" maxlength="8000" aria-label="Message" placeholder="What should the thread be asked?"></textarea>', 'schedules-field-top')}
      <div class="schedules-field"><span>When</span>${segmented('schedules-kinds', 'When', KINDS, 'kind')}</div>
      <div class="schedules-when" data-for="once">${field('At', '<input type="datetime-local" class="schedules-run-at" aria-label="Run at">')}</div>
      <div class="schedules-when" data-for="interval">${field('Every', `<span class="schedules-inline"><input type="number" class="schedules-every" min="${INTERVAL_MIN}" step="1" aria-label="Repeat every"><select class="schedules-unit" aria-label="Unit"><option value="1">minutes</option><option value="60">hours</option></select><small class="schedules-hint">5 minutes to 7 days</small></span>`)}</div>
      <div class="schedules-when" data-for="daily weekdays weekly">${field('Time', '<input type="time" class="schedules-time" aria-label="Time of day">')}</div>
      <div class="schedules-when" data-for="weekly"><div class="schedules-field"><span>Days</span><div class="schedules-days" role="group" aria-label="Days">${DAYS.map((day, index) => `<button type="button" data-day="${index}" aria-pressed="false">${day}</button>`).join('')}</div></div></div>
      <div class="schedules-when" data-for="after">${field('Thread to follow', '<select class="schedules-watch" aria-label="Thread to follow"></select>')}<div class="schedules-field"><span>Only on success</span><input type="checkbox" class="settings-switch schedules-success" aria-label="Only on success"></div><div class="schedules-field"><span>Repeat</span>${segmented('schedules-repeat', 'Repeat', [['next', 'Only the next time'], ['every', 'Every time it finishes']], 'repeat')}</div></div>
      ${field('Stop after', '<span class="schedules-inline"><input type="number" class="schedules-max" min="1" step="1" aria-label="Stop after runs" placeholder="No limit"><span class="schedules-unit-label">runs</span></span>', 'schedules-stop')}
      <p class="schedules-preview" aria-live="polite"></p>
      <p class="schedules-form-error" role="alert" hidden></p>
      <div class="schedules-actions"><button type="button" class="secondary-button" data-cancel>Cancel</button><button type="submit" class="primary-button">Save schedule</button></div>
    </form>
    <form class="schedules-workflow schedules-card" aria-label="Workflow" novalidate hidden>
      ${field('Name', '<input type="text" class="workflow-name" maxlength="80" autocomplete="off" aria-label="Workflow name" placeholder="Optional, e.g. Build, test, review">')}
      <div class="schedules-field"><span>Start</span>${segmented('workflow-starts', 'Start', STARTS, 'start')}</div>
      <div class="workflow-when" data-for="once">${field('At', '<input type="datetime-local" class="workflow-run-at" aria-label="Start at">')}</div>
      <div class="workflow-when" data-for="daily weekdays">${field('Time', '<input type="time" class="workflow-time" aria-label="Start time">')}</div>
      <div class="workflow-when" data-for="after">${field('Thread to follow', '<select class="workflow-watch" aria-label="Start after thread"></select>')}</div>
      <ol class="workflow-steps" aria-label="Steps"></ol>
      <button type="button" class="secondary-button workflow-add">${icon('plus')}Add step</button>
      <div class="schedules-field"><span>Only on success</span><input type="checkbox" class="settings-switch workflow-success" aria-label="Continue only when the previous step succeeds" checked></div>
      ${field('Stop after', '<span class="schedules-inline"><input type="number" class="workflow-max" min="1" step="1" aria-label="Workflow stops after runs" placeholder="No limit"><span class="schedules-unit-label">passes</span></span>')}
      <p class="schedules-preview workflow-preview" aria-live="polite"></p>
      <p class="schedules-form-error" role="alert" hidden></p>
      <div class="schedules-actions"><button type="button" class="secondary-button" data-cancel>Cancel</button><button type="submit" class="primary-button">Save workflow</button></div>
    </form>
    <p class="schedules-error" role="alert" hidden></p>
    <div class="schedules-list"></div>
    <h3 class="settings-heading">Activity</h3>
    <ol class="schedules-activity" aria-label="Recent schedule runs"></ol>
  </div>`;
  const $ = <T extends Element>(selector: string) => host.querySelector<T>(selector)!;
  const banner = $<HTMLElement>('.schedules-paused'), limit = $<HTMLInputElement>('.schedules-limit');
  const filterGroup = $<HTMLElement>('.schedules-filter'), create = $<HTMLButtonElement>('.schedules-new'), createFlow = $<HTMLButtonElement>('.schedules-new-workflow');
  const list = $<HTMLElement>('.schedules-list'), activity = $<HTMLElement>('.schedules-activity'), error = $<HTMLElement>('.schedules-error');
  const editor = $<HTMLFormElement>('.schedules-editor'), formError = editor.querySelector<HTMLElement>('.schedules-form-error')!, preview = editor.querySelector<HTMLElement>('.schedules-preview')!;
  const thread = $<HTMLSelectElement>('.schedules-thread'), title = $<HTMLInputElement>('.schedules-title'), prompt = $<HTMLTextAreaElement>('.schedules-message');
  const kinds = $<HTMLElement>('.schedules-kinds'), runAt = $<HTMLInputElement>('.schedules-run-at'), every = $<HTMLInputElement>('.schedules-every'), unit = $<HTMLSelectElement>('.schedules-unit');
  const time = $<HTMLInputElement>('.schedules-time'), days = $<HTMLElement>('.schedules-days'), watch = $<HTMLSelectElement>('.schedules-watch');
  const success = $<HTMLInputElement>('.schedules-success'), maxRuns = $<HTMLInputElement>('.schedules-max');
  const repeatGroup = $<HTMLElement>('.schedules-repeat'), stopField = $<HTMLElement>('.schedules-stop');
  const flow = $<HTMLFormElement>('.schedules-workflow'), flowError = flow.querySelector<HTMLElement>('.schedules-form-error')!, flowPreview = $<HTMLElement>('.workflow-preview');
  const flowName = $<HTMLInputElement>('.workflow-name'), starts = $<HTMLElement>('.workflow-starts'), flowAt = $<HTMLInputElement>('.workflow-run-at'), flowTime = $<HTMLInputElement>('.workflow-time');
  const flowWatch = $<HTMLSelectElement>('.workflow-watch'), stepList = $<HTMLElement>('.workflow-steps'), addStep = $<HTMLButtonElement>('.workflow-add');
  const flowSuccess = $<HTMLInputElement>('.workflow-success'), flowMax = $<HTMLInputElement>('.workflow-max');

  let schedules: TaskSchedule[] = [], runs: ScheduleRun[] = [], settings: SchedulerSettings | null = null;
  let sessions: Session[] = [], projects: Project[] = [];
  let filter: Filter = 'all', kind: ScheduleKind = 'weekdays', start: Start = 'now', editing: TaskSchedule | null = null;
  let repeat: 'next' | 'every' = 'next', confirming: string | null = null;
  let loaded = false, disposed = false, busy = false, intent = options.intent, menu: (() => void) | undefined;
  const unsubscribes: (() => void)[] = [];

  const showError = (cause: unknown) => { error.textContent = message(cause); error.hidden = false; };
  const threadName = (id: string) => sessions.find(session => session.id === id)?.title ?? schedules.find(s => s.sessionId === id)?.sessionTitle ?? 'Thread';
  const projectOf = (sessionId: string) => sessions.find(session => session.id === sessionId)?.projectId;
  /** Thread options by project; `projectId` keeps one project (a watched thread must share it), `exclude` drops a thread. */
  const sessionOptions = (selected: string, exclude?: string, projectId?: string) => projects.filter(project => !projectId || project.id === projectId).map(project => {
    const items = sessions.filter(session => session.projectId === project.id && session.id !== exclude);
    return items.length ? `<optgroup label="${escape(project.name)}">${items.map(session => `<option value="${escape(session.id)}" ${session.id === selected ? 'selected' : ''}>${escape(session.title)}</option>`).join('')}</optgroup>` : '';
  }).join('');
  const choose = (group: HTMLElement, attr: string, value: string) => {
    group.querySelectorAll<HTMLElement>(`[data-${attr}]`).forEach(button => button.setAttribute('aria-pressed', String(button.dataset[attr] === value)));
    trackSegment(group, group.querySelector<HTMLElement>(`[data-${attr}="${value}"]`));
  };

  function renderSettings(): void {
    if (!settings) return;
    host.querySelectorAll<HTMLInputElement>('[data-setting]').forEach(box => { box.checked = Boolean(settings![box.dataset.setting as keyof SchedulerSettings]); });
    if (document.activeElement !== limit) limit.value = String(settings.agentLimitPerTask);
    banner.hidden = !settings.paused;
    host.classList.toggle('schedules-held', settings.paused);
  }
  async function saveSettings(next: SchedulerSettings): Promise<void> {
    error.hidden = true;
    try { settings = await schedulesApi.setSettings(next); }
    catch (cause) { showError(cause); }
    if (!disposed) { renderSettings(); renderList(); }
  }

  const whenHtml = (at: number | null, short = false) => at === null ? '' : `<span class="schedule-when" data-at="${at}" ${short ? 'data-short' : ''} data-tip="${escape(absolute(at))}">${escape(short ? dayOnly(at) : when(at))}</span>`;
  const held = () => settings?.paused ? 'aria-describedby="schedules-held-note" title="Paused for all schedules"' : '';
  const confirmHtml = (name: string) => `<span class="schedule-confirm">Remove?</span><button type="button" class="secondary-button schedule-confirm-yes" data-remove-yes aria-label="Remove ${escape(name)}">Remove</button><button type="button" class="secondary-button" data-remove-no aria-label="Keep ${escape(name)}">Keep</button>`;
  /** One schedule; steps inside a workflow have no switch of their own (the workflow's switch covers them). */
  function rowHtml(schedule: TaskSchedule, step = false): string {
    const max = schedule.maxRuns, done = Math.min(schedule.runCount, max ?? 0);
    const progress = max && max > 1 ? `<span class="schedule-progress"><span class="schedule-bar" role="progressbar" aria-label="Runs" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${done}"><span style="width:${(done / max) * 100}%"></span></span><small>${done} / ${max} runs</small></span>` : '';
    const spent = isFinished(schedule);
    const next = spent ? `<span class="schedule-when">Done · ran ${schedule.runCount === 1 ? 'once' : `${schedule.runCount} times`}</span>` : !schedule.enabled ? '<span class="schedule-when">Paused</span>' : whenHtml(schedule.nextRunAt, CLOCK_KINDS.includes(schedule.kind));
    const how = schedule.kind === 'after' && !step && schedule.maxRuns === 1 ? `Next time ${cadence(schedule).replace(/^A/, 'a')}` : cadence(schedule);
    const controls = confirming === schedule.id ? confirmHtml(schedule.title)
      : `${step || spent ? '' : `<input type="checkbox" class="settings-switch" data-toggle aria-label="${escape(schedule.title)}" ${held()} ${schedule.enabled ? 'checked' : ''}>`}<button type="button" class="icon-button" data-more aria-haspopup="menu" aria-label="More for ${escape(schedule.title)}" title="More">${icon('more')}</button>`;
    return `<li class="schedule-row" data-id="${escape(schedule.id)}" data-origin="${schedule.createdBy}" data-enabled="${schedule.enabled}">
      <div class="schedule-main"><strong>${escape(schedule.title)}</strong><span class="schedule-meta"><button type="button" class="schedule-thread" data-thread="${escape(schedule.sessionId)}" title="Open thread">${escape(schedule.sessionTitle)}</button><span>${escape(how)}</span>${next}</span>${progress}</div>
      <span class="schedule-origin">${schedule.createdBy === 'agent' ? `${icon('bot')}Agent` : 'You'}</span>${controls}
    </li>`;
  }
  /** A workflow as one unit: a header with one switch and menu, its steps indented below on one connector. */
  function flowHtml(id: string): string {
    const steps = stepsInOrder(schedules.filter(s => s.workflowId === id)), first = steps[0], name = workflowName(first);
    const ran = first.lastRunAt === null ? 0 : steps.filter(s => s.lastRunAt !== null && s.lastRunAt >= first.lastRunAt!).length;
    // A used one-off start or a step that ran out is done, not paused.
    const live = steps.filter(s => !isFinished(s)), enabled = live.length > 0 && live.every(s => s.enabled);
    const status = !live.length ? '<span>Done</span>' : !enabled ? '<span>Paused</span>' : ran > 0 && ran < steps.length ? `<span>${ran} of ${steps.length} ran this pass</span>`
      : first.nextRunAt !== null ? `<span>Next start ${whenHtml(first.nextRunAt, CLOCK_KINDS.includes(first.kind))}</span>` : '';
    const controls = confirming === `flow:${id}` ? confirmHtml(name)
      : `${!live.length ? '' : `<input type="checkbox" class="settings-switch" data-flow-toggle aria-label="${escape(name)}" ${held()} ${enabled ? 'checked' : ''}>`}<button type="button" class="icon-button" data-flow-more aria-haspopup="menu" aria-label="More for ${escape(name)}" title="More">${icon('more')}</button>`;
    return `<li class="schedule-flow" data-workflow="${escape(id)}" data-enabled="${enabled}">
      <div class="schedule-row schedule-flow-head">${icon('branch', 'schedule-flow-icon')}<div class="schedule-main"><strong>${escape(name)}</strong><span class="schedule-meta"><span>${steps.length} steps</span><span>${escape(cadence(first))}</span>${status}</span></div>${controls}</div>
      <ol class="schedule-steps" aria-label="${escape(name)} steps">${steps.map(step => rowHtml(step, true)).join('')}</ol>
    </li>`;
  }
  function renderList(): void {
    const empty = loaded && !schedules.length;
    filterGroup.hidden = empty || !loaded; create.hidden = empty || !editor.hidden; createFlow.hidden = empty || !flow.hidden;
    if (!loaded) { list.innerHTML = '<p class="dialog-loading">Loading…</p>'; return; }
    choose(filterGroup, 'filter', filter);
    if (empty) {
      list.innerHTML = `<div class="schedules-empty schedules-card"><p><strong>Nothing scheduled yet.</strong> Wake a thread later, repeat a check, or chain threads into a workflow.</p>
        <div class="schedules-templates">${TEMPLATES.map(template => `<button type="button" class="schedules-template" data-template="${template.id}"><strong>${template.title}</strong><small>${escape(template.detail ?? brief(template.input!))}</small></button>`).join('')}</div>
        <button type="button" class="primary-button" data-empty-new>${icon('plus')}New schedule</button></div>`;
      return;
    }
    const shown = schedules.filter(s => filter === 'all' || (filter === 'paused' ? !s.enabled : s.createdBy === filter));
    if (!shown.length) { list.innerHTML = '<p class="schedules-none">No schedules match.</p>'; return; }
    const groups = new Map<string, string[]>(), placed = new Set<string>();
    for (const schedule of shown) {
      if (schedule.workflowId && placed.has(schedule.workflowId)) continue;
      const name = schedule.projectName || 'Threads';
      if (schedule.workflowId) placed.add(schedule.workflowId);
      groups.set(name, [...groups.get(name) ?? [], schedule.workflowId ? flowHtml(schedule.workflowId) : rowHtml(schedule)]);
    }
    list.innerHTML = [...groups].map(([name, rows]) => `<section class="schedules-group settings-group" aria-label="${escape(name)}"><h4>${escape(name)}</h4><ul>${rows.join('')}</ul></section>`).join('');
    host.querySelector<HTMLElement>('[data-remove-no]')?.focus();
  }
  function renderActivity(): void {
    const outcome = { started: 'Started', queued: 'Queued', skipped: 'Skipped', failed: 'Failed' };
    activity.innerHTML = runs.length ? runs.map(run => `<li><button type="button" class="schedule-run" data-thread="${escape(run.sessionId)}" data-outcome="${run.outcome}">
      <span class="schedule-dot" role="img" aria-label="${outcome[run.outcome]}"></span>
      <span class="schedule-run-text"><strong>${escape(run.title)}</strong><small>${escape(threadName(run.sessionId))} · ${escape(run.detail)}</small></span>
      ${run.manual ? '<span class="schedule-manual">Run now</span>' : ''}${whenHtml(run.at)}</button></li>`).join('')
      : '<li class="schedules-none">No runs yet.</li>';
  }
  const tick = () => host.querySelectorAll<HTMLElement>('[data-at]').forEach(node => { const at = Number(node.dataset.at); node.textContent = node.dataset.short !== undefined ? dayOnly(at) : when(at); });

  async function load(): Promise<void> {
    try {
      const [nextSchedules, nextRuns, nextSettings, nextSessions, nextProjects] = await Promise.all([
        schedulesApi.list(), schedulesApi.runs({ limit: 50 }), schedulesApi.settings(), call<Session[]>('list_sessions'), call<Project[]>('list_projects')]);
      if (disposed) return;
      schedules = nextSchedules; runs = nextRuns; settings = nextSettings; projects = nextProjects;
      sessions = nextSessions.filter(session => !session.archived && !session.draft);
      loaded = true;
      renderSettings(); renderList(); renderActivity();
      if (intent) { const wanted = intent; intent = undefined; applyIntent(wanted); }
    } catch (cause) { if (!disposed) showError(cause); }
  }
  function applyIntent(wanted: NonNullable<SchedulesSettingsOptions['intent']>): void {
    const target = wanted.editScheduleId && schedules.find(s => s.id === wanted.editScheduleId);
    if (target) openEditor(target);
    else if (wanted.newForSession) openEditor(null, { sessionId: wanted.newForSession });
  }

  // Schedule editor
  function setKind(next: ScheduleKind): void {
    kind = next;
    choose(kinds, 'kind', kind);
    editor.querySelectorAll<HTMLElement>('.schedules-when').forEach(part => { part.hidden = !part.dataset.for!.split(' ').includes(kind); });
    if (kind === 'after') { const current = watch.value; watch.innerHTML = `<option value="">Choose a thread…</option>${sessionOptions(current, thread.value, projectOf(thread.value))}`; }
    setRepeat(repeat);
  }
  function setRepeat(next: 'next' | 'every'): void {
    repeat = next;
    choose(repeatGroup, 'repeat', repeat);
    stopField.hidden = kind === 'after' && repeat === 'next';
    updatePreview();
  }
  function readInput(): ScheduleInput {
    const minutes = Number(every.value) * Number(unit.value), stop = maxRuns.value.trim();
    const at = runAt.value ? new Date(runAt.value).getTime() : NaN;
    return {
      sessionId: thread.value, title: title.value.trim(), prompt: prompt.value, kind,
      intervalMinutes: kind === 'interval' ? (Number.isFinite(minutes) ? Math.round(minutes) : null) : null,
      timeOfDay: ['daily', 'weekdays', 'weekly'].includes(kind) ? time.value || null : null,
      days: kind === 'weekly' ? [...days.querySelectorAll<HTMLElement>('[aria-pressed="true"]')].map(day => Number(day.dataset.day)) : [],
      runAt: kind === 'once' && Number.isFinite(at) ? at : null,
      watchSessionId: kind === 'after' ? watch.value || null : null,
      onlyOnSuccess: kind === 'after' && success.checked,
      maxRuns: kind === 'after' && repeat === 'next' ? 1 : stop ? Math.max(1, Math.round(Number(stop))) || null : null,
    };
  }
  /** The first thing that would stop this schedule from saving, and the field to fix. */
  function problem(input: ScheduleInput): { text: string; field: HTMLElement } | null {
    const minutes = input.intervalMinutes ?? 0;
    if (!input.sessionId) return { text: 'Pick a thread to send to.', field: thread };
    if (kind === 'interval' && !(minutes >= INTERVAL_MIN && minutes <= INTERVAL_MAX)) return { text: 'Intervals are 5 minutes to 7 days.', field: every };
    if (CLOCK_KINDS.includes(kind) && !input.timeOfDay) return { text: 'Pick a time of day.', field: time };
    if (kind === 'weekly' && !input.days?.length) return { text: 'Pick at least one day.', field: days.querySelector('button')! };
    if (kind === 'once' && !(input.runAt && input.runAt > Date.now() - 60_000)) return { text: 'Pick a time in the future.', field: runAt };
    if (kind === 'after' && !input.watchSessionId) return { text: 'Pick a thread to follow.', field: watch };
    return null;
  }
  function updatePreview(): void {
    const input = readInput(), invalid = problem(input);
    every.min = unit.value === '1' ? String(INTERVAL_MIN) : '1';
    preview.classList.toggle('is-hint', Boolean(invalid));
    if (invalid) { preview.textContent = invalid.text; return; }
    const name = sessions.find(session => session.id === input.sessionId)?.title ?? 'a thread';
    const next = nextRun(input);
    const stop = input.maxRuns && !stopField.hidden ? ` · stops after ${input.maxRuns} run${input.maxRuns === 1 ? '' : 's'}` : '';
    preview.textContent = `Sends to ${quote(name)} ${phrase(input, input.watchSessionId ? threadName(input.watchSessionId) : null)}${next ? ` · next: ${when(next)}` : ''}${stop}`;
  }
  function openEditor(schedule: TaskSchedule | null, seed: Partial<ScheduleInput> = {}): void {
    menu?.(); closeWorkflow(false);
    editing = schedule;
    const source: Partial<ScheduleInput> = schedule ? { ...schedule, runAt: schedule.kind === 'once' ? schedule.nextRunAt : null } : seed;
    const sessionId = source.sessionId && sessions.some(s => s.id === source.sessionId) ? source.sessionId : sessions[0]?.id ?? '';
    thread.innerHTML = sessionOptions(sessionId);
    title.value = source.title ?? ''; prompt.value = source.prompt ?? '';
    const minutes = source.intervalMinutes ?? 30, hours = minutes % 60 === 0;
    every.value = String(hours ? minutes / 60 : minutes); unit.value = hours ? '60' : '1';
    time.value = source.timeOfDay ?? '09:00';
    runAt.value = localInput(source.runAt ?? Date.now() + 60 * 60_000);
    days.querySelectorAll<HTMLElement>('[data-day]').forEach(day => day.setAttribute('aria-pressed', String((source.days ?? [new Date().getDay()]).includes(Number(day.dataset.day)))));
    success.checked = source.onlyOnSuccess ?? true;
    repeat = schedule?.kind === 'after' && schedule.maxRuns !== 1 ? 'every' : 'next';
    maxRuns.value = source.maxRuns && !(source.kind === 'after' && repeat === 'next') ? String(source.maxRuns) : '';
    watch.innerHTML = `<option value="">Choose a thread…</option>${sessionOptions(source.watchSessionId ?? '', sessionId, projectOf(sessionId))}`;
    formError.hidden = true; editor.hidden = false; renderList();
    setKind(source.kind ?? 'weekdays');
    (sessionId ? prompt : thread).focus();
  }
  function closeEditor(focus = true): void {
    if (editor.hidden) return;
    editor.hidden = true; editing = null; renderList();
    if (focus) (create.hidden ? host.querySelector<HTMLElement>('[data-empty-new]') : create)?.focus();
  }
  /** Best-effort: the field a native refusal is about, so focus lands where the fix is. */
  function fieldFor(text: string): HTMLElement {
    const t = text.toLowerCase();
    if (/interval/.test(t)) return every;
    if (/day/.test(t) && kind === 'weekly') return days.querySelector('button')!;
    if (/time|passed|one-off|year/.test(t)) return kind === 'once' ? runAt : time;
    if (/watch|follow|wake itself|same project|loop|chain/.test(t)) return kind === 'after' ? watch : thread;
    if (/max runs|stop/.test(t)) return maxRuns;
    if (/title/.test(t)) return title;
    if (/message|prompt/.test(t)) return prompt;
    if (/thread|task/.test(t)) return thread;
    return prompt;
  }
  const fail = (target: HTMLElement, box: HTMLElement, text: string) => { box.textContent = text; box.hidden = false; target.focus(); };
  async function save(): Promise<void> {
    if (busy) return;
    const input = readInput();
    const invalid = problem(input);
    if (invalid) { fail(invalid.field, formError, invalid.text); return; }
    if (!input.prompt.trim()) { fail(prompt, formError, 'Add a message: what should the thread be asked?'); return; }
    busy = true; formError.hidden = true;
    try {
      await (editing ? schedulesApi.update(editing.id, input) : schedulesApi.create(input));
      if (disposed) return;
      closeEditor(); await load();
    } catch (cause) { if (!disposed) fail(fieldFor(message(cause)), formError, message(cause)); }
    finally { busy = false; }
  }

  // Workflow builder: the first step fires on the chosen start, each next step after the previous step's thread.
  function readSteps(): Step[] {
    return [...stepList.querySelectorAll<HTMLElement>('.workflow-step')].map(li => ({ sessionId: li.querySelector('select')!.value, prompt: li.querySelector('textarea')!.value }));
  }
  /** Steps 2+ and the start's thread to follow stay in step 1's project and skip the thread just before them. */
  function renderSteps(steps: Step[]): void {
    const project = projectOf(steps[0]?.sessionId ?? '');
    const choices = (step: Step, index: number) => index === 0 ? sessionOptions(step.sessionId) : sessionOptions(step.sessionId, steps[index - 1].sessionId, project);
    stepList.innerHTML = steps.map((step, index) => `<li class="workflow-step">
      <span class="workflow-step-number" aria-hidden="true">${index + 1}</span>
      <div class="workflow-step-body">
        ${field('Thread', `<select aria-label="Step ${index + 1} thread"><option value="">Choose a thread…</option>${choices(step, index)}</select>`)}
        ${field('Message', `<textarea rows="2" maxlength="8000" aria-label="Step ${index + 1} message" placeholder="What should this thread do?">${escape(step.prompt)}</textarea>`, 'schedules-field-top')}
      </div>
      <button type="button" class="icon-button" data-remove-step="${index}" aria-label="Remove step ${index + 1}" title="Remove step" ${steps.length <= STEPS_MIN ? 'disabled' : ''}>${icon('close')}</button>
    </li>`).join('');
    addStep.disabled = steps.length >= STEPS_MAX;
    flowWatch.innerHTML = `<option value="">Choose a thread…</option>${sessionOptions(flowWatch.value, steps[0]?.sessionId, project)}`;
    updateFlowPreview();
  }
  function setStart(next: Start): void {
    start = next;
    choose(starts, 'start', start);
    flow.querySelectorAll<HTMLElement>('.workflow-when').forEach(part => { part.hidden = !part.dataset.for!.split(' ').includes(start); });
    updateFlowPreview();
  }
  function startInput(): Pick<ScheduleInput, 'kind' | 'runAt' | 'timeOfDay' | 'watchSessionId'> {
    const at = flowAt.value ? new Date(flowAt.value).getTime() : NaN;
    if (start === 'now') return { kind: 'once', runAt: Date.now() };
    if (start === 'once') return { kind: 'once', runAt: Number.isFinite(at) ? at : null };
    if (start === 'after') return { kind: 'after', watchSessionId: flowWatch.value || null };
    return { kind: start, timeOfDay: flowTime.value || null };
  }
  function updateFlowPreview(): void {
    const steps = readSteps(), first = startInput();
    const name = (id: string) => id ? quote(threadName(id)) : 'a thread';
    const begin = start === 'now' ? 'right away' : start === 'after' ? (first.watchSessionId ? `after ${name(first.watchSessionId)} ${flowSuccess.checked ? 'succeeds' : 'finishes'}` : '· pick a thread to follow') : phrase({ ...first, sessionId: '', title: '', prompt: '' }, null);
    const rest = steps.slice(1).map(step => `then ${name(step.sessionId)}`).join(', ');
    flowPreview.textContent = `Starts ${name(steps[0]?.sessionId ?? '')} ${begin}${rest ? `, ${rest}` : ''}${steps.length > 1 ? `, each ${flowSuccess.checked ? 'when the previous step succeeds' : 'when the previous step ends'}` : ''}.`;
  }
  function openWorkflow(): void {
    menu?.(); closeEditor(false);
    flowName.value = ''; flowMax.value = ''; flowSuccess.checked = true; flowTime.value = '09:00';
    flowAt.value = localInput(Date.now() + 60 * 60_000);
    flowWatch.innerHTML = '';
    flowError.hidden = true; flow.hidden = false; renderList();
    const first = sessions[0], second = sessions.find(s => s.projectId === first?.projectId && s.id !== first?.id);
    renderSteps([{ sessionId: first?.id ?? '', prompt: '' }, { sessionId: second?.id ?? '', prompt: '' }]);
    setStart('now');
    flowName.focus();
  }
  function closeWorkflow(focus = true): void {
    if (flow.hidden) return;
    flow.hidden = true; renderList();
    if (focus) (createFlow.hidden ? host.querySelector<HTMLElement>('[data-empty-new]') : createFlow)?.focus();
  }
  async function saveWorkflow(): Promise<void> {
    if (busy) return;
    const steps = readSteps(), first = startInput(), stop = flowMax.value.trim();
    const max = stop ? Math.max(1, Math.round(Number(stop))) || null : null;
    const control = (index: number, part: 'select' | 'textarea') => stepList.querySelectorAll<HTMLElement>('.workflow-step')[index].querySelector<HTMLElement>(part)!;
    const missing = steps.findIndex(step => !step.sessionId || !step.prompt.trim());
    if (missing >= 0) { fail(control(missing, steps[missing].sessionId ? 'textarea' : 'select'), flowError, `Step ${missing + 1} needs a thread and a message.`); return; }
    if (start === 'after' && !first.watchSessionId) { fail(flowWatch, flowError, 'Pick the thread whose finish starts this workflow.'); return; }
    const label = flowName.value.trim() || 'Workflow', workflowId = crypto.randomUUID();
    busy = true; flowError.hidden = true;
    const created: string[] = [];
    try {
      for (const [index, step] of steps.entries()) {
        // Step 1 carries the start (and the optional pass limit); each later step follows the step before it, once per pass.
        const input: ScheduleInput = {
          sessionId: step.sessionId, prompt: step.prompt, title: `${label} · ${index + 1}/${steps.length}`, workflowId, onlyOnSuccess: flowSuccess.checked,
          ...(index === 0 ? { ...first, maxRuns: max } : { kind: 'after' as const, watchSessionId: steps[index - 1].sessionId, chainFromId: created[index - 1], maxRuns: null }),
        };
        try { created.push((await schedulesApi.create(input)).id); }
        catch (cause) { throw Object.assign(new Error(`Step ${index + 1}: ${message(cause)}`), { step: index }); }
      }
      if (disposed) return;
      closeWorkflow(); await load();
    } catch (cause) {
      // All or nothing: a half-built chain would fire steps nobody asked for.
      await Promise.allSettled(created.map(id => schedulesApi.remove(id)));
      if (!disposed) fail(control((cause as { step?: number }).step ?? 0, 'select'), flowError, message(cause));
    } finally { busy = false; }
  }

  // Row actions
  async function act(work: () => Promise<unknown>): Promise<void> {
    error.hidden = true;
    try { await work(); if (!disposed) await load(); } catch (cause) { if (!disposed) { showError(cause); renderList(); } }
  }
  const later = (fn: () => void) => setTimeout(() => { if (!disposed) fn(); });
  const askRemove = (key: string) => later(() => { confirming = key; renderList(); });
  const setAll = async (steps: TaskSchedule[], enabled: boolean) => { for (const step of steps) await schedulesApi.setEnabled(step.id, enabled); };
  /** Same verbs and icons as the thread's wake-up strip. */
  function openMenu(anchor: HTMLElement, schedule: TaskSchedule): void {
    if (menu) { menu(); return; }
    const step = Boolean(schedule.workflowId);
    menu = openChoiceMenu({ anchor, title: `Actions for ${schedule.title}`, actions: true, items: [
      { id: 'run', label: 'Run now', icon: 'arrow' },
      { id: 'snooze', label: 'Snooze 1 h', icon: 'moon', disabled: schedule.kind === 'after' || !schedule.enabled },
      ...step || isFinished(schedule) ? [] : [{ id: 'enable', label: schedule.enabled ? 'Pause' : 'Resume', icon: schedule.enabled ? 'pause' : 'play' }],
      { id: 'edit', label: 'Edit…', icon: 'edit' },
      ...step ? [] : [{ id: 'duplicate', label: 'Duplicate', icon: 'copy' }],
      { id: 'remove', label: 'Remove…', icon: 'trash', danger: true },
    ], onSelect: async id => {
      if (id === 'run') { await schedulesApi.runNow(schedule.id); await load(); }
      else if (id === 'snooze') { await schedulesApi.snooze(schedule.id, SNOOZE_MINUTES); await load(); }
      else if (id === 'enable') { await schedulesApi.setEnabled(schedule.id, !schedule.enabled); await load(); }
      else if (id === 'remove') askRemove(schedule.id);
      else if (id === 'edit') later(() => openEditor(schedule));
      else later(() => openEditor(null, { ...schedule, runAt: schedule.kind === 'once' ? schedule.nextRunAt : null, title: `${schedule.title} (copy)`, workflowId: null, chainFromId: null }));
    }, onClose: () => { menu = undefined; } });
  }
  function openFlowMenu(anchor: HTMLElement, workflowId: string): void {
    if (menu) { menu(); return; }
    const steps = stepsInOrder(schedules.filter(s => s.workflowId === workflowId)), live = steps.filter(s => !isFinished(s)), enabled = live.length > 0 && live.every(s => s.enabled);
    menu = openChoiceMenu({ anchor, title: `Actions for ${workflowName(steps[0])}`, actions: true, items: [
      { id: 'run', label: 'Run from start', icon: 'arrow' },
      ...live.length ? [{ id: 'enable', label: enabled ? 'Pause' : 'Resume', icon: enabled ? 'pause' : 'play' }] : [],
      { id: 'remove', label: 'Remove workflow…', icon: 'trash', danger: true },
    ], onSelect: async id => {
      if (id === 'run') { await schedulesApi.runNow(steps[0].id); await load(); }
      else if (id === 'enable') { await setAll(live, !enabled); await load(); }
      else askRemove(`flow:${workflowId}`);
    }, onClose: () => { menu = undefined; } });
  }
  function confirmRemove(): void {
    const key = confirming; confirming = null;
    if (!key) return;
    const ids = key.startsWith('flow:') ? schedules.filter(s => s.workflowId === key.slice(5)).map(s => s.id) : [key];
    void act(async () => { for (const id of ids) await schedulesApi.remove(id); }).then(() => { if (!disposed) (create.hidden ? host.querySelector<HTMLElement>('[data-empty-new]') : create)?.focus(); });
  }

  host.addEventListener('change', event => {
    const target = event.target as HTMLElement;
    if (target instanceof HTMLInputElement && target.dataset.setting && settings) void saveSettings({ ...settings, [target.dataset.setting]: target.checked });
    if (target === limit && settings) {
      const value = Number(limit.value);
      if (!Number.isInteger(value) || value < LIMIT_MIN || value > LIMIT_MAX) { showError(new Error(`The agent limit is ${LIMIT_MIN} to ${LIMIT_MAX} schedules per thread.`)); limit.value = String(settings.agentLimitPerTask); return; }
      void saveSettings({ ...settings, agentLimitPerTask: value });
    }
    const row = target.closest<HTMLElement>('.schedule-row');
    if (row && target instanceof HTMLInputElement && target.dataset.toggle !== undefined) void act(() => schedulesApi.setEnabled(row.dataset.id!, target.checked));
    const workflowId = target.closest<HTMLElement>('[data-workflow]')?.dataset.workflow;
    if (workflowId && target instanceof HTMLInputElement && target.dataset.flowToggle !== undefined) void act(() => setAll(schedules.filter(s => s.workflowId === workflowId && !isFinished(s)), target.checked));
    if (target instanceof HTMLSelectElement && stepList.contains(target)) {
      const label = target.getAttribute('aria-label')!;
      renderSteps(readSteps());
      stepList.querySelector<HTMLElement>(`select[aria-label="${label}"]`)?.focus();
    }
    if (editor.contains(target)) { if (target === thread && kind === 'after') setKind(kind); updatePreview(); }
    if (flow.contains(target)) updateFlowPreview();
  });
  host.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const data = (attr: string) => target.closest<HTMLElement>(`[data-${attr}]`)?.getAttribute(`data-${attr}`) ?? null;
    if (data('filter')) { filter = data('filter') as Filter; renderList(); return; }
    if (data('kind')) { setKind(data('kind') as ScheduleKind); return; }
    if (data('start')) { setStart(data('start') as Start); return; }
    if (data('repeat')) { setRepeat(data('repeat') as 'next' | 'every'); return; }
    if (target.closest('[data-resume-all]') && settings) { void saveSettings({ ...settings, paused: false }); return; }
    if (target.closest('[data-remove-yes]')) { confirmRemove(); return; }
    if (target.closest('[data-remove-no]')) {
      const key = confirming ?? ''; confirming = null; renderList();
      host.querySelector<HTMLElement>(key.startsWith('flow:') ? `[data-workflow="${CSS.escape(key.slice(5))}"] [data-flow-more]` : `[data-id="${CSS.escape(key)}"] [data-more]`)?.focus();
      return;
    }
    const day = target.closest<HTMLElement>('[data-day]');
    if (day) { day.setAttribute('aria-pressed', String(day.getAttribute('aria-pressed') !== 'true')); updatePreview(); return; }
    if (target.closest('.schedules-new, [data-empty-new]')) { openEditor(null); return; }
    if (target.closest('.schedules-new-workflow')) { openWorkflow(); return; }
    if (target.closest('.workflow-add')) { renderSteps([...readSteps(), { sessionId: '', prompt: '' }]); stepList.querySelector<HTMLElement>('.workflow-step:last-child select')!.focus(); return; }
    if (data('remove-step')) { const at = Number(data('remove-step')); renderSteps(readSteps().filter((_, index) => index !== at)); addStep.focus(); return; }
    if (target.closest('[data-cancel]')) { if (editor.contains(target)) closeEditor(); else closeWorkflow(); return; }
    const template = TEMPLATES.find(t => t.id === data('template'));
    if (template) { if (template.input) openEditor(null, template.input); else openWorkflow(); return; }
    if (data('thread')) { options.openThread(data('thread')!); return; }
    const schedule = schedules.find(s => s.id === target.closest<HTMLElement>('.schedule-row')?.dataset.id);
    const more = target.closest<HTMLElement>('[data-more]');
    if (schedule && more) { openMenu(more, schedule); return; }
    const flowMore = target.closest<HTMLElement>('[data-flow-more]'), flowId = target.closest<HTMLElement>('[data-workflow]')?.dataset.workflow;
    if (flowMore && flowId) openFlowMenu(flowMore, flowId);
  });
  editor.addEventListener('input', updatePreview);
  flow.addEventListener('input', updateFlowPreview);
  editor.addEventListener('submit', event => { event.preventDefault(); void save(); });
  flow.addEventListener('submit', event => { event.preventDefault(); void saveWorkflow(); });
  for (const [form, close, submit] of [[editor, closeEditor, save], [flow, closeWorkflow, saveWorkflow]] as const) {
    form.addEventListener('keydown', event => {
      if (event.isComposing) return;
      // Escape closes the form, not Settings; ⌘/Ctrl Enter saves from a message box.
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === 'Enter' && event.target instanceof HTMLTextAreaElement && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
    });
  }

  const timer = setInterval(tick, REFRESH_MS);
  void subscribe(SCHEDULES_CHANGED, () => { if (!busy) void load(); }).then(stop => { if (disposed) stop(); else unsubscribes.push(stop); });
  renderList();
  void load();
  return () => {
    disposed = true; clearInterval(timer); menu?.();
    unsubscribes.forEach(stop => stop());
    host.replaceChildren();
  };
}
