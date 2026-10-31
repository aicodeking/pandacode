/** A thread's wake-ups: the strip above the composer, the quick-add popover, transcript markers,
 *  `/wake` and the sidebar glyph. Data comes from `schedules-api.ts`; main.ts passes callbacks in. */
import { subscribe } from './bridge';
import { escape, icon, morph } from './dom';
import { cadence, clockAt, schedulesApi, TRACE_HEADER, when, type ScheduleInput, type ScheduleRun, type SchedulerSettings, type TaskSchedule, isFinished } from './schedules-api';

export interface WakeHost {
  sessionId(): string;
  showChoices(anchor: HTMLElement, options: { title: string; actions?: boolean; width?: number; items: { id: string; label: string; icon?: string; danger?: boolean }[]; onSelect: (id: string) => void | Promise<void> }): Promise<void>;
  /** Settings → Schedules; an empty intent just opens the section. */
  openSettings(intent: { newForSession?: string; editScheduleId?: string }): void;
  notify(text: string): void;
  report(error: unknown): void;
  /** The sidebar glyphs changed. */
  changed(): void;
}

const MINUTE = 60_000, HISTORY = 8, TICK = 30_000;
const OUTCOME: Record<ScheduleRun['outcome'], string> = { started: 'Started', queued: 'Queued', skipped: 'Skipped', failed: 'Failed' };
const REPEAT = [['once', 'Once'], ['interval', 'Every hour'], ['daily', 'Daily'], ['weekdays', 'Weekdays']] as const;
export const DEFAULT_WAKE_PROMPT = 'Continue where you left off.';

let host: WakeHost | undefined;
let schedules: TaskSchedule[] = [];
let runs: ScheduleRun[] = [], runsFor = '';
let settings: SchedulerSettings | null = null;
let paused = false, expanded = false, confirming = '', loading = 0, ticker = 0;

export async function initWakeups(next: WakeHost): Promise<void> {
  host = next;
  document.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-wake]');
    if (target) void act(target).catch(error => next.report(error));
  });
  // Esc folds the open strip before anything else (a running agent included) hears it.
  document.addEventListener('keydown', event => {
    const strip = document.getElementById('wake-strip');
    if (event.key !== 'Escape' || !expanded || !strip?.contains(document.activeElement) || document.querySelector('.floating-menu:not(.wake-popover)')) return;
    event.preventDefault(); event.stopPropagation();
    expanded = false; confirming = ''; paint();
    strip.querySelector<HTMLElement>('.wake-toggle')?.focus();
  }, true);
  document.addEventListener('visibilitychange', paint);
  await subscribe('schedules-changed', () => void refreshWakeups());
  await refreshWakeups();
}

export async function refreshWakeups(): Promise<void> {
  if (!host) return;
  const id = host.sessionId(), request = ++loading;
  try {
    const [list, history, loaded] = await Promise.all([
      schedulesApi.list(null), id ? schedulesApi.runs({ sessionId: id, limit: HISTORY }) : Promise.resolve([]), schedulesApi.settings(),
    ]);
    if (request !== loading) return;
    schedules = list; runs = history; runsFor = id; settings = loaded; paused = loaded.paused;
  } catch (error) { if (request === loading) host.report(error); return; }
  paint(); host.changed();
}

function upcoming(sessionId: string): TaskSchedule | undefined {
  return schedules.filter(s => s.sessionId === sessionId && s.enabled && s.nextRunAt !== null)
    .sort((a, b) => a.nextRunAt! - b.nextRunAt!)[0];
}

/** The sidebar row's clock, for a thread with an enabled upcoming wake-up. */
export function wakeGlyph(sessionId: string): string {
  const next = upcoming(sessionId); if (!next) return '';
  const label = paused ? 'Schedules paused' : `Wakes ${when(next.nextRunAt)}`;
  return `<span class="task-wake${paused ? ' is-paused' : ''}" role="img" aria-label="${escape(label)}" title="${escape(label)}">${icon('clock')}</span>`;
}

/** Markup for the strip above the composer; main.ts places it and `paint()` keeps it current. */
export function wakeStrip(sessionId: string): string {
  if (runsFor !== sessionId) void refreshWakeups();
  const inner = stripInner(sessionId);
  if (inner) startTicker();
  return `<section id="wake-strip" class="wake-strip${paused ? ' is-paused' : ''}" aria-label="Wake-ups"${inner ? '' : ' hidden'}>${inner}</section>`;
}

function stripInner(sessionId: string): string {
  const mine = schedules.filter(s => s.sessionId === sessionId);
  const history = runsFor === sessionId ? runs : [];
  if (!mine.length && !history.length) return '';
  const next = upcoming(sessionId);
  const summary = paused && mine.length ? '<strong>On hold</strong> · Schedules are paused'
    : next ? `Next wake-up <strong>${escape(when(next.nextRunAt))}</strong> · ${escape(next.title)}`
    : mine.length ? 'No wake-up coming up' : 'Recent wake-ups';
  const count = mine.length ? `<span class="wake-count">${mine.length}<span class="sr-only"> scheduled</span></span>` : '';
  const hold = paused && mine.length ? '<button type="button" class="wake-text-button wake-resume" data-wake="resume-all">Resume</button><button type="button" class="wake-text-button wake-settings" data-wake="settings">Settings</button>' : '';
  const line = `<div class="wake-line"><button type="button" class="wake-toggle" data-wake="expand" aria-expanded="${expanded}" aria-controls="wake-body">${icon('clock')}<span class="wake-summary">${summary}</span>${count}${icon('down', 'wake-chevron')}</button>${hold}<button type="button" class="icon-button wake-add" data-wake="add" aria-label="Wake this thread later" title="Wake this thread later" aria-haspopup="dialog">${icon('plus')}</button></div>`;
  if (!expanded) return line;
  const list = mine.length ? `<ul class="wake-list">${mine.map(row).join('')}</ul>` : '';
  const trace = history.length ? `<section class="wake-history" aria-label="Wake-up history"><h4>History</h4><ol>${history.map(run => `<li class="wake-run"><span class="wake-dot" data-outcome="${run.outcome}" role="img" aria-label="${OUTCOME[run.outcome]}" title="${OUTCOME[run.outcome]}"></span><span class="wake-run-title">${escape(run.title)}</span><span class="wake-run-detail">${escape(run.detail)}${run.manual ? ' · Run now' : ''}</span><time>${escape(when(run.at))}</time></li>`).join('')}</ol></section>` : '';
  return `${line}<div id="wake-body" class="wake-body">${list}${trace}</div>`;
}

function row(s: TaskSchedule): string {
  const name = escape(s.title);
  const timing = s.enabled ? `${escape(cadence(s))}${s.nextRunAt !== null ? ` · ${escape(when(s.nextRunAt))}` : ''}` : `${escape(cadence(s))} · ${isFinished(s) ? 'Done' : 'Paused'}`;
  const actions = confirming === s.id
    ? `<span class="wake-confirm">Remove?</span><button type="button" class="wake-text-button danger" data-wake="remove-yes" aria-label="Remove ${name}">Remove</button><button type="button" class="wake-text-button" data-wake="remove-no">Keep</button>`
    : `<button type="button" class="wake-text-button" data-wake="run" aria-label="Run now: ${name}">${icon('play')}<span>Run now</span></button><button type="button" class="icon-button" data-wake="more" aria-haspopup="menu" aria-label="More actions for ${name}" title="More">${icon('more')}</button>`;
  return `<li class="wake-row" data-id="${escape(s.id)}" data-enabled="${s.enabled}"><span class="wake-title" title="${escape(s.prompt)}">${name}</span><span class="wake-meta">${timing}</span><span class="wake-origin" data-origin="${s.createdBy}">${s.createdBy === 'agent' ? 'Agent' : 'You'}</span><span class="wake-actions">${actions}</span></li>`;
}

function paint(): void {
  const strip = document.getElementById('wake-strip');
  if (!strip || !host) return stopTicker();
  const inner = stripInner(host.sessionId());
  strip.hidden = !inner; strip.classList.toggle('is-paused', paused); morph(strip, inner, 6);
  if (inner && !document.hidden) startTicker(); else stopTicker();
}
function startTicker(): void { if (!ticker) ticker = window.setInterval(() => { if (document.hidden || document.getElementById('wake-strip')?.hidden !== false) stopTicker(); else { paint(); host?.changed(); } }, TICK); }
function stopTicker(): void { window.clearInterval(ticker); ticker = 0; }

/** Opens the strip on a schedule and focuses its row, if it is still there. */
function reveal(scheduleId: string): void {
  const strip = document.getElementById('wake-strip');
  if (!strip || strip.hidden) { host?.notify('That wake-up is no longer scheduled.'); return; }
  expanded = true; confirming = ''; paint();
  const target = strip.querySelector<HTMLElement>(`.wake-row[data-id="${CSS.escape(scheduleId)}"] [data-wake="run"]`);
  if (target) { target.scrollIntoView({ block: 'nearest' }); target.focus(); }
  else { strip.querySelector<HTMLElement>('.wake-toggle')?.focus(); host?.notify('That wake-up is no longer scheduled.'); }
}

async function act(target: HTMLElement): Promise<void> {
  const action = target.dataset.wake!, id = target.closest<HTMLElement>('.wake-row')?.dataset.id ?? '';
  const schedule = schedules.find(s => s.id === id);
  if (action === 'expand') { expanded = !expanded; confirming = ''; paint(); return; }
  if (action === 'add') { openWakeComposer(target); return; }
  if (action === 'settings') { host?.openSettings({}); return; }
  if (action === 'resume-all') { if (settings) await schedulesApi.setSettings({ ...settings, paused: false }); await refreshWakeups(); document.querySelector<HTMLElement>('#wake-strip .wake-toggle')?.focus(); return; }
  if (action === 'reveal') { reveal(target.dataset.schedule ?? ''); return; }
  if (!schedule || !host) return;
  if (action === 'run') { target.setAttribute('disabled', ''); const run = await schedulesApi.runNow(id); host.notify(`${OUTCOME[run.outcome]}: ${run.detail || schedule.title}`); }
  else if (action === 'more') { await showMore(target, schedule); return; }
  else if (action === 'remove-no') { confirming = ''; paint(); focusRow(id, 'more'); return; }
  else if (action === 'remove-yes') { confirming = ''; await schedulesApi.remove(id); host.notify(`Removed “${schedule.title}”`); }
  else return;
  await refreshWakeups();
}
function focusRow(id: string, wake: string): void {
  document.querySelector<HTMLElement>(`#wake-strip .wake-row[data-id="${CSS.escape(id)}"] [data-wake="${wake}"]`)?.focus();
}

/** The row's ⋯ menu: snooze, pause or resume, edit, remove. */
async function showMore(anchor: HTMLElement, schedule: TaskSchedule): Promise<void> {
  const snooze = schedule.kind !== 'after' && schedule.nextRunAt !== null && schedule.enabled;
  const items = [
    ...snooze ? [{ id: 'snooze:10', label: 'Snooze 10 min', icon: 'moon' }, { id: 'snooze:60', label: 'Snooze 1 h', icon: 'moon' }, { id: 'snooze:1440', label: 'Snooze until tomorrow', icon: 'moon' }] : [],
    ...isFinished(schedule) ? [] : [{ id: 'enable', label: schedule.enabled ? 'Pause' : 'Resume', icon: schedule.enabled ? 'pause' : 'play' }],
    { id: 'edit', label: 'Edit…', icon: 'edit' },
    { id: 'remove', label: 'Remove…', icon: 'trash', danger: true },
  ];
  await host!.showChoices(anchor, { title: schedule.title, actions: true, width: 240, items, onSelect: async choice => {
    if (choice.startsWith('snooze:')) await schedulesApi.snooze(schedule.id, Number(choice.slice(7)));
    else if (choice === 'enable') await schedulesApi.setEnabled(schedule.id, !schedule.enabled);
    else if (choice === 'edit') { host!.openSettings({ editScheduleId: schedule.id }); return; }
    else if (choice === 'remove') { confirming = schedule.id; paint(); queueMicrotask(() => focusRow(schedule.id, 'remove-no')); return; }
    await refreshWakeups();
    focusRow(schedule.id, 'more');
  } });
}

// Transcript trace --------------------------------------------------------------------------------
export interface ScheduledTrace {
  title: string; scheduleId: string; cadence: string; run: string;
  /** "You", "This thread's agent" or "Agent in “Title”". */
  who: string; manual: boolean;
  /** For trigger-fired schedules: "after “Build” finished successfully". */
  trigger: string;
}
/** Reads the block a fired schedule appends (header plus labelled lines); missing lines are tolerated. */
export function scheduledTrace(content: string): ScheduledTrace | null {
  // The scheduler appends its block last; reading from the last header means a prompt that quotes
  // an earlier trace cannot pass itself off as a wake-up.
  const index = content.lastIndexOf(`\n\n${TRACE_HEADER}`); if (index < 0) return null;
  const lines = content.slice(index + 2).split('\n');
  const line = (label: string) => lines.find(text => text.startsWith(label))?.slice(label.length).trim() ?? '';
  const meta = line('Schedule ID:'), trigger = line('Trigger:').replace(/\s*·\s*local time .*$/, '');
  const by = /· set by (.+?)(?: · started with Run now)?$/.exec(meta)?.[1] ?? '';
  const agentIn = /^an agent in (“.*”)/.exec(by)?.[1];
  const run = /· run (\d+)(?: of (\d+))?/.exec(meta);
  return {
    title: lines[0].slice(TRACE_HEADER.length).replace(/^:\s*/, '').trim(),
    scheduleId: /^(\S+)/.exec(meta)?.[1] ?? '',
    cadence: /^\S+ · (.+?) · run \d/.exec(meta)?.[1] ?? '',
    run: run ? `run ${run[1]}${run[2] ? ` of ${run[2]}` : ''}` : '',
    who: agentIn ? `Agent in ${agentIn}` : /^(the user|you)$/i.test(by) ? 'You' : by ? 'This thread’s agent' : '',
    manual: /· started with Run now\s*$/.test(meta),
    trigger: trigger.startsWith('“') ? `after ${trigger.replace(/\s*\([^)]*\)/g, '')}` : '',
  };
}
/** The marker over a user message a schedule sent; a button that opens the wake-ups strip on it. */
export function scheduledMark(content: string): string {
  const trace = scheduledTrace(content); if (!trace) return '';
  const parts = [workflowStep(trace.scheduleId), trace.cadence, trace.run, trace.who, trace.trigger].filter(Boolean).map(text => `<span>${escape(text)}</span>`).join('');
  return `<button type="button" class="scheduled-mark" data-wake="reveal" data-schedule="${escape(trace.scheduleId)}" title="Show this thread’s wake-ups">${icon('clock')}<strong>Woken by ${escape(trace.title || 'a schedule')}</strong>${parts}${trace.manual ? '<span class="scheduled-tag">Run now</span>' : ''}</button>`;
}

/** "Step 2 of 3 · Build, test, review" for a workflow step that still exists; '' otherwise. */
function workflowStep(scheduleId: string): string {
  const step = schedules.find(s => s.id === scheduleId); if (!step?.workflowId) return '';
  // The workflow builder titles steps "<name> · 2/3"; fall back to the order the steps were made in.
  const titled = /^(.*) · (\d+)\/(\d+)$/.exec(step.title);
  if (titled) return `Step ${titled[2]} of ${titled[3]} · ${titled[1]}`;
  const steps = schedules.filter(s => s.workflowId === step.workflowId).sort((a, b) => a.createdAt - b.createdAt);
  return `Step ${steps.indexOf(step) + 1} of ${steps.length} · Workflow`;
}

// /wake ------------------------------------------------------------------------------------------
/** `30m check CI`, `2h`, `9:00 …`, `tomorrow …`, `tomorrow 14:30 …` → when, and the message. */
export function parseWake(args: string, now = Date.now()): { runAt: number; prompt: string } {
  const match = /^(?:(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)|(\d{1,2}):(\d{2})|(tomorrow)(?:\s+(\d{1,2}):(\d{2}))?)(?=\s|$)\s*([\s\S]*)$/i.exec(args.trim());
  if (!match) throw new Error('Try /wake 30m check CI, /wake 9:00 review the build, or /wake tomorrow continue.');
  const [, amount, unit, hour, minute, tomorrow, tHour, tMinute, rest] = match;
  let runAt: number;
  if (amount) runAt = now + Number(amount) * (/^h/i.test(unit) ? 60 : 1) * MINUTE;
  else {
    const date = new Date(now), h = Number(hour ?? tHour ?? 9), m = Number(minute ?? tMinute ?? 0);
    if (h > 23 || m > 59) throw new Error('Times are HH:MM, 24-hour.');
    date.setHours(h, m, 0, 0);
    if (tomorrow) date.setDate(date.getDate() + 1); else if (date.getTime() <= now) date.setDate(date.getDate() + 1);
    runAt = date.getTime();
  }
  if (runAt <= now) throw new Error('Pick a time in the future.');
  const prompt = rest.trim() || DEFAULT_WAKE_PROMPT;
  return { runAt, prompt: prompt[0].toLocaleUpperCase() + prompt.slice(1) };
}
/** Runs `/wake <args>` for a thread: no arguments opens the quick add over `anchor`. */
export async function wakeCommand(sessionId: string, args: string, anchor: HTMLElement): Promise<void> {
  if (!args.trim()) { openWakeComposer(anchor, sessionId); return; }
  const { runAt, prompt } = parseWake(args);
  const created = await schedulesApi.create({ sessionId, title: prompt.split('\n', 1)[0].slice(0, 60), prompt, kind: 'once', runAt });
  host?.notify(`Wakes ${when(created.nextRunAt) || 'later'}: ${created.title}`);
  await refreshWakeups();
}

// Quick add ------------------------------------------------------------------------------------
let closePopover: (() => void) | undefined;
const pad = (n: number) => String(n).padStart(2, '0');
const localValue = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function presets(now = Date.now()): { id: string; label: string; at: () => number }[] {
  const at = (days: number, hour: number) => () => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d.getTime(); };
  // "Tonight" is 18:00 until 17:30, then 21:00 until 20:30; later than that it would be too soon to mean anything.
  const minutes = new Date(now).getHours() * 60 + new Date(now).getMinutes();
  const tonight = minutes < 17 * 60 + 30 ? 18 : minutes < 20 * 60 + 30 ? 21 : 0;
  return [
    { id: '15', label: 'In 15 min', at: () => Date.now() + 15 * MINUTE },
    { id: '60', label: 'In 1 h', at: () => Date.now() + 60 * MINUTE },
    ...tonight ? [{ id: 'tonight', label: `Tonight ${clockAt(at(0, tonight)())}`, at: at(0, tonight) }] : [],
    { id: 'tomorrow', label: `Tomorrow ${clockAt(at(1, 9)())}`, at: at(1, 9) },
  ];
}

/** Opens "Wake this thread later" over `anchor` for a thread (the open one by default). */
export function openWakeComposer(anchor: HTMLElement, sessionId = host?.sessionId() ?? ''): void {
  if (!host || !sessionId) return;
  closePopover?.();
  const choices = presets();
  let preset = '60';
  const popover = document.createElement('div');
  popover.className = 'floating-menu wake-popover';
  popover.setAttribute('role', 'dialog'); popover.setAttribute('aria-label', 'Wake this thread later');
  popover.innerHTML = `<form class="wake-form"><strong class="wake-form-title">${icon('clock')}Wake this thread later</strong>
    <label class="wake-field"><span>Message</span><textarea name="prompt" rows="2">${escape(DEFAULT_WAKE_PROMPT)}</textarea></label>
    <div class="wake-presets" role="group" aria-label="When">${choices.map(c => `<button type="button" class="wake-chip" data-preset="${c.id}" aria-pressed="${c.id === preset}">${escape(c.label)}</button>`).join('')}</div>
    <div class="wake-row-fields"><label class="wake-field wake-at"><span>At</span><input type="datetime-local" name="at"></label>
    <label class="wake-field"><span>Repeat</span><select name="repeat">${REPEAT.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label></div>
    <p class="wake-error" role="alert" hidden></p>
    <div class="wake-form-footer"><button type="button" class="wake-text-button" data-more>More options…</button><span></span><button type="button" class="secondary-button" data-cancel>Cancel</button><button type="submit" class="primary-button">Schedule</button></div></form>`;
  const form = popover.querySelector('form')!;
  const at = form.querySelector<HTMLInputElement>('[name="at"]')!, error = form.querySelector<HTMLElement>('.wake-error')!;
  const repeatField = form.querySelector<HTMLSelectElement>('[name="repeat"]')!;
  const pick = (id: string) => {
    preset = id;
    form.querySelectorAll<HTMLElement>('[data-preset]').forEach(chip => chip.setAttribute('aria-pressed', String(chip.dataset.preset === id)));
    const choice = choices.find(c => c.id === id); if (choice) at.value = localValue(choice.at());
  };
  pick(preset);
  // Every hour starts from now, so a time would mean nothing.
  repeatField.addEventListener('change', () => {
    const hourly = repeatField.value === 'interval';
    form.querySelector<HTMLElement>('.wake-presets')!.hidden = hourly;
    form.querySelector<HTMLElement>('.wake-at')!.hidden = hourly;
  });
  const close = (refocus = true) => {
    popover.remove(); document.removeEventListener('pointerdown', outside, true); closePopover = undefined;
    if (refocus) (anchor.isConnected ? anchor : document.querySelector<HTMLElement>('#prompt'))?.focus({ preventScroll: true });
  };
  const outside = (event: Event) => { if (!popover.contains(event.target as Node)) close(false); };
  closePopover = () => close(false);
  popover.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== 'Tab') return;
    // Focus stays inside the popover until it closes.
    const stops = [...popover.querySelectorAll<HTMLElement>('textarea, button, input, select')].filter(node => !node.closest('[hidden]') && !(node as HTMLButtonElement).disabled);
    const first = stops[0], last = stops[stops.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  popover.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    const chip = target.closest<HTMLElement>('[data-preset]'); if (chip) pick(chip.dataset.preset!);
    if (target.closest('[data-cancel]')) close();
    if (target.closest('[data-more]')) { close(false); host!.openSettings({ newForSession: sessionId }); }
  });
  at.addEventListener('input', () => pick(''));
  form.addEventListener('submit', event => {
    event.preventDefault(); error.hidden = true;
    const prompt = form.querySelector<HTMLTextAreaElement>('[name="prompt"]')!.value.trim();
    const repeat = repeatField.value as ScheduleInput['kind'];
    // A relative preset counts from the moment you press Schedule, not when the popover opened.
    const runAt = choices.find(c => c.id === preset)?.at() ?? (at.value ? new Date(at.value).getTime() : NaN);
    const fail = (message: string) => { error.textContent = message; error.hidden = false; };
    if (!Number.isFinite(runAt) && repeat !== 'interval') return fail('Pick a time.');
    const time = Number.isFinite(runAt) ? `${pad(new Date(runAt).getHours())}:${pad(new Date(runAt).getMinutes())}` : null;
    const input: ScheduleInput = { sessionId, title: prompt.split('\n', 1)[0].slice(0, 60), prompt, kind: repeat,
      ...(repeat === 'once' ? { runAt } : repeat === 'interval' ? { intervalMinutes: 60 } : { timeOfDay: time }) };
    const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!; submit.disabled = true;
    schedulesApi.create(input).then(created => {
      close(); host!.notify(`Wakes ${when(created.nextRunAt) || 'later'}: ${created.title}`); void refreshWakeups();
    }, reason => { submit.disabled = false; fail(reason instanceof Error ? reason.message : String(reason)); });
  });
  document.body.append(popover);
  const rect = anchor.getBoundingClientRect(), width = popover.offsetWidth, height = popover.offsetHeight;
  // Keep clear of an open inspector; right-align to the trigger when its left edge would run past that.
  const inspector = document.querySelector<HTMLElement>('#inspector');
  const edge = Math.min(innerWidth, inspector && inspector.offsetWidth && inspector.getBoundingClientRect().left > rect.left ? inspector.getBoundingClientRect().left : innerWidth) - 12;
  const left = rect.left + width <= edge ? rect.left : rect.right - width;
  popover.style.left = `${Math.max(12, Math.min(left, edge - width))}px`;
  // Above the trigger when it fits (the composer), otherwise below it (a sidebar row near the top).
  if (rect.top - height - 8 >= 12) popover.style.bottom = `${innerHeight - rect.top + 8}px`;
  else popover.style.top = `${Math.min(rect.bottom + 8, innerHeight - height - 12)}px`;
  document.addEventListener('pointerdown', outside, true);
  form.querySelector<HTMLTextAreaElement>('textarea')!.focus();
}
