import type { ToolActivity } from './types';
import { escape, icon } from './dom.ts';
import {
  COMPLETE, PARTIAL, badge, basename, clip, clipText, domain, excerptCard, field, kvTable, lines, list, resultCard, searchCard, section, terminalCard, text,
  parseJson, type Fields, type ListItem, type Trace, type TraceChip,
} from './tool-trace.ts';

/** Rows and result cards for PandaCode's own MCP tools (team, tasks, VMs, simulators, design, browser, cloud, bots, Jev). Pure and escaped. */
export type PandaFamily = 'team' | 'task' | 'vm' | 'simulator' | 'design' | 'browser' | 'cloud' | 'code' | 'moodboard' | 'bot' | 'jev' | 'meta';
type Status = ToolActivity['status'];
type Out = { json: unknown; obj: Fields; text: string };
type Row = { chip?: TraceChip; object?: string; mono?: boolean; verbs?: [string, string] };
type Spec = { family: PandaFamily; icon: string; verbs: [string, string]; row?: (f: Fields, o: Out) => Row; card?: (f: Fields, o: Out, status: Status) => string };

const PREFIX = /^(?:mcp__)?pandacode(?:_architect)?(?:__| · |\.|\/)(.+)$/;

/** The bare PandaCode tool (`dispatch_workers`) from any harness's spelling, else undefined. */
export function pandacodeTool(name: string): string | undefined {
  const n = name.trim().toLowerCase();
  const served = PREFIX.exec(n);
  const rest = (served ? served[1] : n).replace(/^pandacode_architect_/, '');
  if (rest.startsWith('pandacode_')) return rest.slice('pandacode_'.length) || undefined;
  return served && /^[a-z0-9_]+$/.test(rest) ? rest : undefined;
}

// --- Small builders ---------------------------------------------------------

function isObj(value: unknown): value is Fields { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function objects(value: unknown): Fields[] { return Array.isArray(value) ? value.filter(isObj) : []; }
function count(n: number, one: string, many = one + 's'): string { return `${n} ${n === 1 ? one : many}`; }
function chip(label: string, iconName: string, title = label): TraceChip | undefined {
  return label ? { icon: iconName, label: clip(label, 40), title } : undefined;
}
function shortId(id: string): string { return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id) ? id.slice(0, 8) : id; }
function prose(value: string, limit = 600): string {
  return value.trim() ? `${value.length > limit ? PARTIAL : ''}<p class="tool-trace-prose">${escape(clipText(value, limit))}</p>` : '';
}
function note(value: string): string { return value.trim() ? `${value.length > 240 ? PARTIAL : ''}<p class="tool-trace-note">${escape(clip(value, 240))}</p>` : ''; }
const label = section;
/** The full text only when the row clipped it; otherwise the row already says everything. */
function beyond(value: string, shown: number, limit = 600): string { return value.length > shown ? prose(value, limit) : ''; }
/** Fields the row did not already show. */
function rest(f: Fields, shown: string[]): Fields {
  return Object.fromEntries(Object.entries(f).filter(([key]) => !shown.includes(key)));
}
function files(paths: unknown, limit = 4): string {
  const all = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [];
  if (!all.length) return '';
  const more = all.length > limit ? `<span class="tool-trace-more">+${all.length - limit}</span>` : '';
  return `<span class="tool-trace-files">${all.slice(0, limit).map(p => `<code title="${escape(p)}">${escape(clip(p, 48))}</code>`).join('')}${more}</span>`;
}
function bubble(from: string, to: string, message: string, meta = ''): string {
  const route = `<b>${escape(clip(from || 'you', 40))}</b>${to ? `<span aria-hidden="true">→</span><b>${escape(clip(to, 40))}</b>` : ''}`;
  return `<div class="tool-trace-bubble"><div class="tool-trace-bubble-head">${route}${meta ? `<span class="tool-trace-card-meta">${escape(meta)}</span>` : ''}</div>${prose(message, 500)}</div>`;
}
function time(value: unknown): string {
  const n = typeof value === 'number' ? value : 0;
  if (!n) return '';
  const date = new Date(n < 1e12 ? n * 1000 : n);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(11, 16);
}
function host(url: string): string {
  try { const parsed = new URL(url); return parsed.port ? `${parsed.hostname}:${parsed.port}` : domain(url); } catch { return clip(url, 60); }
}
function isLocal(url: string): boolean { return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url); }
function size(bytes: unknown): string {
  return typeof bytes === 'number' ? bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} kB` : '';
}

// --- Workers and teams ------------------------------------------------------

function route(worker: Fields): string {
  const model = [field(worker, 'provider'), field(worker, 'model')].filter(Boolean).join(' · ') || field(worker, 'profileId');
  return [model, field(worker, 'reasoningEffort')].filter(Boolean).join(' · ');
}
function roster(workers: Fields[], statusOf: (worker: Fields, index: number) => string = worker => field(worker, 'status')): string {
  if (!workers.length) return '';
  const rows = workers.slice(0, 12).map((worker, index) => {
    const name = field(worker, 'name', 'key', 'id', 'workerId') || `Worker ${index + 1}`;
    const body = field(worker, 'summary', 'prompt', 'error');
    const depends = Array.isArray(worker.dependsOn) && worker.dependsOn.length ? `after ${worker.dependsOn.join(', ')}` : '';
    const meta = [route(worker), depends].filter(Boolean).join(' · ');
    return `<li><div class="tool-trace-roster-head">${icon('bot')}<b>${escape(clip(name, 60))}</b>${meta ? `<span class="tool-trace-route">${escape(clip(meta, 80))}</span>` : ''}${worker.you === true ? '<span class="tool-trace-badge is-quiet">you</span>' : ''}${worker.readOnly === true ? '<span class="tool-trace-badge is-quiet">read-only</span>' : ''}${badge(statusOf(worker, index))}</div>${body ? `<p class="tool-trace-roster-text">${escape(clip(body, 220))}</p>` : ''}${files(worker.files)}</li>`;
  }).join('');
  const more = workers.length > 12 ? `<li class="tool-trace-more">+${workers.length - 12} more</li>` : '';
  return `<ul class="tool-trace-roster">${rows}${more}</ul>`;
}
function assignments(f: Fields): Fields[] { return objects(f.assignments).length ? objects(f.assignments) : objects(f.workers).length ? objects(f.workers) : objects(f.tasks); }
function dispatchCard(f: Fields, o: Out): string {
  const ids = Array.isArray(o.obj.workerIds) ? o.obj.workerIds : [];
  const status = (_: Fields, i: number) => { const id = ids[i]; return isObj(id) ? field(id, 'status') : ids.length ? 'queued' : ''; };
  const workers = assignments(f);
  return (workers.length ? roster(workers, status) : roster(objects(ids))) + note(field(o.obj, 'note'));
}
function messages(o: Out): string {
  const all = objects(o.obj.messages);
  if (!all.length) return Array.isArray(o.obj.messages) ? note('No new messages.') : '';
  return all.slice(-6).map(m => bubble(field(m, 'sender', 'from', 'role'), field(m, 'recipient', 'to'), field(m, 'message', 'content', 'text'), time(m.createdAt))).join('')
    + (all.length > 6 ? `<p class="tool-trace-more">+${all.length - 6} earlier</p>` : '');
}
const worker = (f: Fields): TraceChip | undefined => chip(field(f, 'workerId', 'recipient'), 'bot');

// --- Tasks ------------------------------------------------------------------

function taskItem(task: Fields, withText = true): ListItem {
  return { title: field(task, 'title') || shortId(field(task, 'id')) || 'Task', meta: [field(task, 'provider'), field(task, 'model'), withText ? field(task, 'excerpt', 'description') : ''].filter(Boolean).join(' · '), hint: field(task, 'id'), badge: field(task, 'stage', 'status') };
}
function taskCard(f: Fields, o: Out): string {
  const many = objects(o.obj.tasks);
  if (many.length) return list(many.map(t => taskItem(t)), many.length);
  const one = isObj(o.obj.task) ? o.obj.task : field(o.obj, 'id', 'title') ? o.obj : field(f, 'title') ? f : undefined;
  if (!one) return '';
  const history = objects(o.obj.messages);
  // The row already names the task: show only what it lacks.
  const item = taskItem(one, false);
  return (item.meta || item.badge ? `<p class="tool-trace-note">${item.badge ? badge(item.badge) + ' ' : ''}${escape(item.meta ?? '')}</p>` : '') + prose(field(one, 'description') || field(f, 'description'), 300) + (history.length ? note(`${count(history.length, 'message')} read${o.obj.hasOlder === true ? ', older ones remain' : ''}`) : '');
}
const task = (f: Fields, o: Out): TraceChip | undefined => chip(field(o.obj, 'title') || (isObj(o.obj.task) ? field(o.obj.task, 'title') : '') || shortId(field(f, 'taskId')) || '', 'board', field(f, 'taskId'));

// --- Machines ---------------------------------------------------------------

function machines(o: Out): ListItem[] {
  const local = objects(o.obj.vms).map(vm => ({ title: field(vm, 'name'), meta: ['local', vm.diskGb ? `${vm.diskGb} GB` : ''].filter(Boolean).join(' · '), badge: vm.running === true ? 'running' : vm.running === false ? 'stopped' : field(vm, 'state') }));
  const cloud = objects(o.obj.cloud).map(vm => ({ title: field(vm, 'name', 'id'), meta: [field(vm, 'provider'), field(vm, 'os'), vm.desktop === true ? 'desktop' : ''].filter(Boolean).join(' · '), hint: field(vm, 'id'), badge: field(vm, 'state') }));
  return [...local, ...cloud];
}
function machineCard(_: Fields, o: Out): string {
  const all = machines(o);
  return (all.length ? list(all, all.length) : note('No machines yet.')) + note(field(o.obj, 'engine'));
}
function deviceCard(_: Fields, o: Out): string {
  const devices = objects(o.obj.devices);
  return list(devices.map(d => ({ title: field(d, 'name'), meta: [field(d, 'runtime').replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, ''), field(o.obj, 'shown') === field(d, 'udid') ? 'shown' : ''].filter(Boolean).join(' · '), hint: field(d, 'udid'), badge: field(d, 'state') })), devices.length)
    + note(field(o.obj, 'touchInput').startsWith('missing') ? `Touch input ${field(o.obj, 'touchInput')}` : '');
}
function point(f: Fields, x = 'x', y = 'y'): string { return typeof f[x] === 'number' && typeof f[y] === 'number' ? `(${f[x]}, ${f[y]})` : ''; }
/** `Clicked at (420, 88)`, `Typed “hello”`, `Pressed cmd+space` from a computer-use action. */
function action(f: Fields): Row {
  const act = field(f, 'action');
  const typed = clip(field(f, 'text'), 50);
  switch (act) {
    case 'type': return { verbs: ['Typing', 'Typed'], object: typed ? `“${typed}”` : '' };
    case 'key': return { verbs: ['Pressing', 'Pressed'], object: field(f, 'keys', 'key'), mono: true };
    case 'button': return { verbs: ['Pressing', 'Pressed'], object: `${field(f, 'button')} button` };
    case 'scroll': return { verbs: ['Scrolling', 'Scrolled'], object: [field(f, 'direction'), point(f)].filter(Boolean).join(' at ') };
    case 'swipe': return { verbs: ['Swiping', 'Swiped'], object: [point(f), point(f, 'endX', 'endY')].filter(Boolean).join(' → ') };
    case 'drag': return { verbs: ['Dragging', 'Dragged'], object: [point(f), point(f, 'endX', 'endY')].filter(Boolean).join(' → ') };
    case 'move': return { verbs: ['Moving pointer', 'Moved pointer'], object: point(f) ? `to ${point(f)}` : '' };
    case 'tap_label': return { verbs: ['Tapping', 'Tapped'], object: `“${clip(field(f, 'label'), 50)}”` };
    default: return POINTER[act] ? { verbs: POINTER[act], object: point(f) ? `at ${point(f)}` : '' } : {};
  }
}
const POINTER: Record<string, [string, string]> = {
  click: ['Clicking', 'Clicked'], double_click: ['Double-clicking', 'Double-clicked'], right_click: ['Right-clicking', 'Right-clicked'], middle_click: ['Middle-clicking', 'Middle-clicked'],
  tap: ['Tapping', 'Tapped'], double_tap: ['Double-tapping', 'Double-tapped'], long_press: ['Long-pressing', 'Long-pressed'],
};
const ACTION_SHOWN = ['name', 'udid', 'action', 'x', 'y', 'endX', 'endY', 'direction', 'keys', 'key', 'button', 'label', 'screenshot'];
/** Only what the row did not say: long typed text, extra options, and any text result. */
function actionCard(f: Fields, o: Out): string {
  const extra = rest(f, [...ACTION_SHOWN, 'text']);
  return beyond(field(f, 'text'), 50, 2000) + kvTable(extra, 'Options') + (o.text.trim() && !o.json ? note(o.text) : o.json ? resultCard(o.text) : '');
}
const shotCard = (_: Fields, o: Out): string => o.json ? '' : note(o.text);
const MANAGE: Record<string, [string, string]> = {
  create: ['Creating', 'Created'], start: ['Starting', 'Started'], stop: ['Stopping', 'Stopped'], suspend: ['Suspending', 'Suspended'], delete: ['Deleting', 'Deleted'],
  show: ['Showing', 'Showed'], install_desktop: ['Installing desktop on', 'Installed desktop on'], boot: ['Booting', 'Booted'], shutdown: ['Shutting down', 'Shut down'],
  install: ['Installing app on', 'Installed app on'], launch: ['Launching', 'Launched'], terminate: ['Quitting', 'Quit'], open_url: ['Opening link on', 'Opened link on'],
  appearance: ['Switching appearance of', 'Switched appearance of'], pose: ['Folding', 'Folded'],
};
function manage(noun: string, target: (f: Fields) => string, iconName: string) {
  return (f: Fields): Row => {
    const act = field(f, 'action');
    const what = target(f);
    const object = act === 'install' ? basename(field(f, 'path'))
      : field(f, 'image') ? `from ${field(f, 'image')}` : field(f, 'provider') ? `on ${field(f, 'provider')}`
      : field(f, 'appearance', 'pose') ? `to ${field(f, 'appearance', 'pose')}` : field(f, 'bundleId', 'url');
    return { verbs: MANAGE[act] ?? ['Managing', 'Managed'], chip: chip(what || noun, iconName), object };
  };
}
const MANAGE_SHOWN = ['action', 'name', 'udid', 'path', 'image', 'provider', 'appearance', 'pose', 'bundleId', 'url'];
const manageCard = (f: Fields, o: Out): string => kvTable(rest(f, MANAGE_SHOWN), 'Options') + (o.text.trim() ? resultCard(o.text) : '');
const machine = (f: Fields): string => field(f, 'name');
const device = (f: Fields): string => shortId(field(f, 'udid'));

// --- Design, browser, code, cloud -------------------------------------------

function artboard(name: string): string { return name.replace(/\.html?$/i, ''); }
function artboardCard(_: Fields, o: Out): string {
  const boards = objects(o.obj.artboards);
  const open = typeof o.obj.openComments === 'number' ? o.obj.openComments : 0;
  return list(boards.map(b => ({ title: artboard(field(b, 'name')), meta: [size(b.size), field(b, 'path')].filter(Boolean).join(' · '), hint: field(b, 'path') })), boards.length)
    + (boards.length ? '' : note('No artboards yet.')) + (open ? note(`${count(open, 'open comment')}`) : '');
}
function commentCard(_: Fields, o: Out): string {
  const all = objects(o.obj.comments);
  return all.length ? list(all.map(c => ({ title: field(c, 'text'), meta: [artboard(field(c, 'artboard')), field(c, 'selector')].filter(Boolean).join(' · '), badge: field(c, 'status') })), all.length) : note('No comments.');
}
function serverCard(_: Fields, o: Out): string {
  const all = Array.isArray(o.json) ? objects(o.json) : objects(o.obj.servers);
  return all.length ? list(all.map(s => ({ title: `:${s.port ?? ''}`, meta: [field(s, 'process'), field(s, 'url')].filter(Boolean).join(' · '), hint: field(s, 'url') })), all.length) : note('No local servers are listening.');
}
function pageCard(_: Fields, o: Out): string {
  const url = field(o.obj, 'url');
  return (url ? list([{ title: field(o.obj, 'title') || host(url), meta: url, hint: url }]) : '')
    + (field(o.obj, 'text') ? prose(field(o.obj, 'text'), 400) : url ? '' : resultCard(o.text));
}
function codeCard(f: Fields, o: Out): string {
  const results = field(o.obj, 'results') || (o.json ? '' : o.text);
  return (results ? searchCard(results) : note(`No matches for ${field(f, 'query')}.`)) + (o.obj.truncated === true ? note('Results were truncated.') : '');
}
function trackCard(f: Fields, o: Out): string {
  const paths = Array.isArray(f.paths) ? f.paths.filter((p): p is string => typeof p === 'string') : [];
  const capture = field(o.obj, 'captureId');
  return list(paths.map(p => ({ title: basename(p), meta: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '', hint: capture ? `${p} · capture ${capture}` : p })), paths.length);
}
function cloudCard(f: Fields, o: Out, status: Status): string {
  return terminalCard(`${field(f, 'tool')} ${field(f, 'args')}`.trim(), o.text, status) + (o.obj.truncated === true ? note('Output was truncated.') : '');
}
function itemsCard(key: string, titleKeys: string[], metaKeys: string[]) {
  return (_: Fields, o: Out): string => {
    const all = Array.isArray(o.json) ? objects(o.json) : objects(o.obj[key]);
    return all.length ? list(all.map(item => ({ title: field(item, ...titleKeys) || shortId(field(item, 'id')), meta: metaKeys.map(k => text(item[k]) || (typeof item[k] === 'number' ? String(item[k]) : '')).filter(Boolean).join(' · '), hint: field(item, 'id'), badge: field(item, 'status', 'state') })), all.length) : resultCard(o.text);
  };
}
function reportCard(_: Fields, o: Out): string {
  const checks = objects(o.obj.checks);
  const head = [field(o.obj, 'status', 'verdict', 'outcome'), field(o.obj, 'summary', 'advice', 'recommendation')];
  if (!head[0] && !head[1] && !checks.length) return resultCard(o.text);
  return (head[0] ? `<div class="tool-trace-card-head tool-trace-verdict">${badge(head[0])}${field(o.obj, 'runId') ? `<span class="tool-trace-card-meta">${escape(shortId(field(o.obj, 'runId')))}</span>` : ''}</div>` : '')
    + prose(head[1], 400) + list(checks.map(c => ({ title: field(c, 'name', 'label', 'check'), meta: field(c, 'detail', 'evidence'), badge: c.passed === true ? 'passed' : c.passed === false ? 'failed' : field(c, 'status') })), checks.length);
}

// --- Catalog ----------------------------------------------------------------

const promptCard = (key: string) => (f: Fields, o: Out): string => label('Message', prose(field(f, key), 500)) + (o.json ? '' : excerptCard(o.text));

/** Mutations whose row says everything: no card unless they fail. */
const rowOnly = (): string => COMPLETE;

/** "in 30 min", "at 18:30", "every 2 h", "weekdays at 09:00", "after another thread" from a schedule tool's input. */
function scheduleTiming(f: Fields): string {
  const minutes = (value: unknown) => { const n = Number(value); return n < 60 ? `${n} min` : `${Math.round(n / 6) / 10} h`.replace('.0 ', ' '); };
  const time = field(f, 'timeOfDay'), kind = field(f, 'kind');
  if (kind === 'interval' && Number(f.intervalMinutes) > 0) return `every ${minutes(f.intervalMinutes)}`;
  if (kind === 'cron' && field(f, 'cron')) return `${field(f, 'cron')}${field(f, 'timezone') ? ` · ${field(f, 'timezone')}` : ''}`;
  if ((kind === 'daily' || kind === 'weekdays' || kind === 'weekly') && time) return `${kind} at ${time}${field(f, 'timezone') ? ` · ${field(f, 'timezone')}` : ''}`;
  if (kind === 'after' || field(f, 'afterTaskId')) return 'after another thread';
  if (Number(f.inMinutes) > 0) return `in ${minutes(f.inMinutes)}`;
  const at = field(f, 'at');
  if (/^\d{1,2}:\d{2}$/.test(at)) return `at ${at}`;
  const date = at ? new Date(at) : null;
  return date && !Number.isNaN(date.getTime()) ? `at ${date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : '';
}
const scheduleRow = (what: string) => (f: Fields): Row => ({ object: [what, scheduleTiming(f), clip(field(f, 'title', 'note', 'text'), 60)].filter(Boolean).join(' · ') });

const CATALOG: Record<string, Spec> = {
  schedule_wakeup: { family: 'task', icon: 'clock', verbs: ['Scheduling', 'Scheduled'], row: scheduleRow('a wake-up'), card: promptCard('note') },
  schedule_message: { family: 'task', icon: 'clock', verbs: ['Scheduling', 'Scheduled'], row: scheduleRow('a message'), card: promptCard('text') },
  cancel_schedule: { family: 'task', icon: 'clock', verbs: ['Cancelling', 'Cancelled'], row: () => ({ object: 'a schedule' }), card: rowOnly },
  list_schedules: { family: 'task', icon: 'clock', verbs: ['Checking', 'Checked'], row: () => ({ object: 'schedules' }), card: rowOnly },
  dispatch_workers: { family: 'team', icon: 'bot', verbs: ['Dispatching', 'Dispatched'], row: f => ({ object: assignments(f).length ? count(assignments(f).length, 'worker') : 'workers' }), card: dispatchCard },
  list_workers: { family: 'team', icon: 'bot', verbs: ['Checking', 'Checked'], row: (_, o) => ({ object: objects(o.obj.workers).length ? count(objects(o.obj.workers).length, 'worker') : 'workers' }), card: (_, o) => (typeof o.obj.round === 'number' ? note(`Round ${o.obj.round}${typeof o.obj.maxRounds === 'number' ? ` of ${o.obj.maxRounds}` : ''}`) : '') + roster(objects(o.obj.workers)) },
  read_worker: { family: 'team', icon: 'bot', verbs: ['Reading', 'Read'], row: f => ({ chip: worker(f), object: 'report' }), card: (_, o) => `<div class="tool-trace-card-head">${badge(field(o.obj, 'status'))}${o.obj.readOnly === true ? '<span class="tool-trace-badge is-quiet">read-only</span>' : ''}</div>` + label('Summary', prose(field(o.obj, 'summary'), 400)) + label('Response', prose(field(o.obj, 'response'), 500)) + files(o.obj.files) },
  followup_worker: { family: 'team', icon: 'bot', verbs: ['Following up with', 'Followed up with'], row: f => ({ chip: worker(f), object: clip(field(f, 'prompt'), 80) }), card: f => beyond(field(f, 'prompt'), 80) + files(f.files) + (f.readOnly === true ? '<p class="tool-trace-note">Read-only</p>' : '') },
  cancel_worker: { family: 'team', icon: 'stop', verbs: ['Cancelling', 'Cancelled'], row: f => ({ chip: worker(f), object: clip(field(f, 'reason'), 80) }), card: f => beyond(field(f, 'reason'), 80) },
  finish_team: { family: 'team', icon: 'check', verbs: ['Finishing team', 'Finished team'], card: f => label('Summary', prose(field(f, 'summary'), 1200)) },
  team_directory: { family: 'team', icon: 'grid', verbs: ['Reading team directory', 'Read team directory'], row: (_, o) => ({ object: objects(o.obj.workers).length ? `· ${count(objects(o.obj.workers).length, 'teammate')}` : '' }), card: (_, o) => roster(objects(o.obj.workers).map(w => field(w, 'id') && field(w, 'id') === field(o.obj, 'you') ? { ...w, you: true } : w)) },
  send_team_message: { family: 'team', icon: 'chat', verbs: ['Sending message to', 'Sent message to'], row: f => ({ chip: worker(f) }), card: (f, o) => bubble('you', field(f, 'recipient'), field(f, 'message'), o.obj.duplicate === true ? 'already sent' : o.obj.saved === true ? 'delivered' : '') + messages({ ...o, obj: isObj(o.obj.mailbox) ? o.obj.mailbox : {} }) },
  read_team_mailbox: { family: 'team', icon: 'chat', verbs: ['Checking mailbox', 'Checked mailbox'], row: (_, o) => ({ object: Array.isArray(o.obj.messages) ? `· ${count(o.obj.messages.length, 'message')}` : '' }), card: (_, o) => messages(o) },
  checkpoint_worker: { family: 'team', icon: 'pin', verbs: ['Saving checkpoint', 'Saved checkpoint'], row: f => ({ object: clip(field(f, 'summary'), 80) }), card: f => label('Progress', beyond(field(f, 'summary'), 80, 400)) + label('Next', prose(field(f, 'nextSteps'), 300)) + (field(f, 'blocker') ? `<p class="tool-trace-note is-error">${escape(clip(field(f, 'blocker'), 300))}</p>` : '') },
  delegate: { family: 'team', icon: 'bot', verbs: ['Delegating', 'Delegated'], row: f => ({ object: clip(field(f, 'prompt', 'title'), 90) }), card: (f, o) => label('Assignment', beyond(field(f, 'prompt', 'title'), 90, 400)) + label('Result', resultCard(o.text)) },

  create_task: { family: 'task', icon: 'plus', verbs: ['Creating task', 'Created task'], row: f => ({ object: field(f, 'title') ? `“${clip(field(f, 'title'), 60)}”` : '' }), card: taskCard },
  start_task: { family: 'task', icon: 'play', verbs: ['Starting task', 'Started task'], row: (f, o) => ({ chip: task(f, o) }), card: taskCard },
  open_task: { family: 'task', icon: 'board', verbs: ['Opening task', 'Opened task'], row: (f, o) => ({ chip: task(f, o) }), card: rowOnly },
  list_tasks: { family: 'task', icon: 'board', verbs: ['Listing tasks', 'Listed tasks'], row: (f, o) => ({ object: [f.archived === true ? 'archived' : '', objects(o.obj.tasks).length ? `· ${count(objects(o.obj.tasks).length, 'task')}` : ''].filter(Boolean).join(' ') }), card: taskCard },
  read_task: { family: 'task', icon: 'board', verbs: ['Reading task', 'Read task'], row: (f, o) => ({ chip: task(f, o) ?? chip('this task', 'board') }), card: taskCard },
  search_tasks: { family: 'task', icon: 'search', verbs: ['Searching tasks', 'Searched tasks'], row: f => ({ object: field(f, 'query') ? `for “${clip(field(f, 'query'), 60)}”` : '' }), card: (f, o) => taskCard(f, o) || note('No tasks matched.') },
  rename_task: { family: 'task', icon: 'edit', verbs: ['Renaming task', 'Renamed task'], row: f => ({ chip: chip(shortId(field(f, 'taskId')), 'board', field(f, 'taskId')), object: `to “${clip(field(f, 'title'), 60)}”` }), card: taskCard },
  pin_task: { family: 'task', icon: 'pin', verbs: ['Pinning', 'Pinned'], row: (f, o) => ({ chip: task(f, o), verbs: f.pinned === false ? ['Unpinning', 'Unpinned'] : undefined }), card: rowOnly },
  archive_task: { family: 'task', icon: 'archive', verbs: ['Archiving', 'Archived'], row: (f, o) => ({ chip: task(f, o), verbs: f.archived === false ? ['Restoring', 'Restored'] : undefined }), card: rowOnly },
  set_task_stage: { family: 'task', icon: 'move', verbs: ['Moving', 'Moved'], row: (f, o) => ({ chip: task(f, o), object: field(f, 'stage') ? `to ${field(f, 'stage')}` : '' }), card: rowOnly },
  steer_task: { family: 'task', icon: 'arrow-right', verbs: ['Steering', 'Steered'], row: (f, o) => ({ chip: task(f, o) }), card: promptCard('text') },
  interrupt_task: { family: 'task', icon: 'stop', verbs: ['Interrupting', 'Interrupted'], row: (f, o) => ({ chip: task(f, o) }), card: rowOnly },
  send_message: { family: 'task', icon: 'chat', verbs: ['Sending message to', 'Sent message to'], row: (f, o) => ({ chip: task(f, o) }), card: promptCard('text') },
  queue_message: { family: 'task', icon: 'plan', verbs: ['Queuing message for', 'Queued message for'], row: (f, o) => ({ chip: task(f, o) ?? chip('this task', 'board') }), card: promptCard('text') },
  list_queue: { family: 'task', icon: 'plan', verbs: ['Reading queue', 'Read queue'], row: (_, o) => ({ object: Array.isArray(o.json) ? `· ${count(o.json.length, 'message')}` : '' }), card: (f, o) => itemsCard('messages', ['text'], ['position'])(f, o) || note('The queue is empty.') },
  remove_queued: { family: 'task', icon: 'trash', verbs: ['Removing queued message', 'Removed queued message'], row: f => ({ chip: chip(shortId(field(f, 'entryId')), 'plan', field(f, 'entryId')) }), card: rowOnly },
  list_subagents: { family: 'task', icon: 'bot', verbs: ['Listing subagents', 'Listed subagents'], card: itemsCard('subagents', ['name'], ['prompt']) },
  create_worktree: { family: 'task', icon: 'worktree', verbs: ['Creating worktree', 'Created worktree'], row: f => ({ chip: chip(field(f, 'branch'), 'branch') }), card: taskCard },
  list_projects: { family: 'task', icon: 'folder', verbs: ['Listing projects', 'Listed projects'], card: itemsCard('projects', ['name'], ['path']) },

  vm_list: { family: 'vm', icon: 'monitor', verbs: ['Listing machines', 'Listed machines'], row: (_, o) => ({ object: o.json ? `· ${count(machines(o).length, 'machine')}` : '' }), card: machineCard },
  vm_screenshot: { family: 'vm', icon: 'camera', verbs: ['Taking screenshot of', 'Took screenshot of'], row: f => ({ chip: chip(machine(f) || 'VM', 'monitor') }), card: shotCard },
  vm_control: { family: 'vm', icon: 'monitor', verbs: ['Controlling', 'Controlled'], row: f => ({ ...action(f), chip: chip(machine(f) || 'VM', 'monitor') }), card: actionCard },
  vm_manage: { family: 'vm', icon: 'monitor', verbs: ['Managing', 'Managed'], row: manage('VM', machine, 'monitor'), card: manageCard },

  simulator_devices: { family: 'simulator', icon: 'phone', verbs: ['Listing simulators', 'Listed simulators'], row: (_, o) => ({ object: objects(o.obj.devices).length ? `· ${count(objects(o.obj.devices).length, 'device')}` : '' }), card: deviceCard },
  simulator_screenshot: { family: 'simulator', icon: 'camera', verbs: ['Taking screenshot of', 'Took screenshot of'], row: f => ({ chip: chip(device(f) || 'Simulator', 'phone', field(f, 'udid')) }), card: shotCard },
  simulator_describe: { family: 'simulator', icon: 'phone', verbs: ['Reading screen of', 'Read screen of'], row: f => ({ chip: chip(device(f) || 'Simulator', 'phone', field(f, 'udid')) }), card: (_, o) => excerptCard(o.text) },
  simulator_control: { family: 'simulator', icon: 'phone', verbs: ['Controlling', 'Controlled'], row: f => ({ ...action(f), chip: chip(device(f) || 'Simulator', 'phone', field(f, 'udid')) }), card: actionCard },
  simulator_manage: { family: 'simulator', icon: 'phone', verbs: ['Managing', 'Managed'], row: manage('Simulator', device, 'phone'), card: manageCard },

  design_list: { family: 'design', icon: 'sketch', verbs: ['Listing artboards', 'Listed artboards'], row: (_, o) => ({ object: Array.isArray(o.obj.artboards) ? `· ${count(o.obj.artboards.length, 'artboard')}` : '' }), card: artboardCard },
  design_write: { family: 'design', icon: 'sketch', verbs: ['Writing artboard', 'Wrote artboard'], row: f => ({ chip: chip(artboard(field(f, 'name')), 'sketch', field(f, 'name')), object: field(f, 'html') ? `${lines(field(f, 'html')).length} lines` : '' }), card: (f, o) => note([field(o.obj, 'saved'), size(field(f, 'html').length)].filter(Boolean).join(' · ')) || COMPLETE },
  design_comments: { family: 'design', icon: 'chat', verbs: ['Reading design comments', 'Read design comments'], row: (f, o) => ({ object: [field(f, 'status'), Array.isArray(o.obj.comments) ? `· ${count(o.obj.comments.length, 'comment')}` : ''].filter(Boolean).join(' ') }), card: commentCard },
  design_resolve: { family: 'design', icon: 'check', verbs: ['Resolving comment', 'Resolved comment'], row: f => ({ chip: chip(shortId(field(f, 'id')), 'chat', field(f, 'id')) }), card: f => prose(field(f, 'note'), 300) },

  preview_file: { family: 'browser', icon: 'globe', verbs: ['Opening preview', 'Opened preview'], row: f => ({ chip: chip(basename(field(f, 'path')), 'file', field(f, 'path')) }), card: rowOnly },
  run_project: { family: 'browser', icon: 'play', verbs: ['Running project', 'Ran project'], row: (_, o) => ({ object: field(o.obj, 'url', 'preview') ? `· ${host(field(o.obj, 'url', 'preview'))}` : '' }), card: (_, o) => resultCard(o.text) },
  open_browser: { family: 'browser', icon: 'globe', verbs: ['Opening', 'Opened'], row: f => { const url = field(f, 'url'); return isLocal(url) ? { verbs: ['Opening preview', 'Opened preview'], object: `:${(() => { try { return new URL(url).port || '80'; } catch { return ''; } })()}`, mono: true } : { chip: chip(host(url), 'globe', url) }; }, card: pageCard },
  read_browser: { family: 'browser', icon: 'globe', verbs: ['Reading page', 'Read page'], row: (_, o) => ({ chip: field(o.obj, 'url') ? chip(host(field(o.obj, 'url')), 'globe', field(o.obj, 'url')) : undefined }), card: pageCard },
  browser_action: { family: 'browser', icon: 'refresh', verbs: ['Navigating', 'Navigated'], row: f => ({ verbs: ({ back: ['Going back', 'Went back'], forward: ['Going forward', 'Went forward'], reload: ['Reloading page', 'Reloaded page'], stop: ['Stopping page', 'Stopped page'] } as Record<string, [string, string]>)[field(f, 'action')] }), card: rowOnly },
  browser_click: { family: 'browser', icon: 'select', verbs: ['Clicking', 'Clicked'], row: f => ({ object: clip(field(f, 'selector'), 80), mono: true }), card: pageCard },
  browser_type: { family: 'browser', icon: 'text', verbs: ['Typing into', 'Typed into'], row: f => ({ object: clip(field(f, 'selector'), 80), mono: true }), card: f => label('Text', prose(field(f, 'text'), 400)) },
  capture_browser: { family: 'browser', icon: 'camera', verbs: ['Capturing browser', 'Captured browser'], card: (_, o) => note(o.text) },
  open_file: { family: 'browser', icon: 'file', verbs: ['Opening', 'Opened'], row: f => ({ chip: chip(basename(field(f, 'path')), 'file', field(f, 'path')), object: field(f, 'view') === 'raw' ? 'source' : '' }), card: rowOnly },
  open_terminal: { family: 'browser', icon: 'terminal', verbs: ['Opening terminal', 'Opened terminal'] , card: rowOnly },
  list_local_servers: { family: 'browser', icon: 'server', verbs: ['Listing local servers', 'Listed local servers'], row: (_, o) => ({ object: Array.isArray(o.json) ? `· ${count(o.json.length, 'server')}` : '' }), card: serverCard },

  cloud_cli: { family: 'cloud', icon: 'upload', verbs: ['Running', 'Ran'], row: f => ({ chip: chip(field(f, 'tool'), 'terminal'), object: clip(field(f, 'args'), 100), mono: true }), card: cloudCard },
  code_search: { family: 'code', icon: 'search', verbs: ['Searching code', 'Searched code'], row: f => ({ verbs: f.symbols === true ? ['Finding symbol', 'Found symbol'] : undefined, object: field(f, 'query') ? `${f.symbols === true ? '' : 'for '}${clip(field(f, 'query'), 70)}` : '', mono: f.symbols === true }), card: codeCard },
  track_files: { family: 'code', icon: 'edit', verbs: ['Tracking', 'Tracked'], row: f => { const n = Array.isArray(f.paths) ? f.paths.length : 0; return { verbs: field(f, 'action') === 'complete' ? undefined : ['Tracking changes to', 'Tracking changes to'], object: count(n, 'file') }; }, card: trackCard },
  title: { family: 'meta', icon: 'text', verbs: ['Naming', 'Named'], row: f => ({ object: field(f, 'title') ? `the task “${clip(field(f, 'title'), 60)}”` : 'the task' }), card: rowOnly },
  coordination: { family: 'team', icon: 'chat', verbs: ['Coordinating', 'Coordinated'] },
  test: { family: 'meta', icon: 'check', verbs: ['Testing tools', 'Tested tools'] },

  list_moodboards: { family: 'moodboard', icon: 'images', verbs: ['Listing moodboards', 'Listed moodboards'], card: itemsCard('boards', ['name', 'title'], ['imageCount', 'count']) },
  read_moodboard: { family: 'moodboard', icon: 'images', verbs: ['Reading moodboard', 'Read moodboard'], row: (f, o) => ({ chip: chip(field(o.obj, 'name') || shortId(field(f, 'boardId')), 'images', field(f, 'boardId')) }), card: itemsCard('images', ['name', 'caption'], ['caption']) },
  read_moodboard_image: { family: 'moodboard', icon: 'images', verbs: ['Viewing reference', 'Viewed reference'], row: f => ({ chip: chip(shortId(field(f, 'imageId')), 'images', field(f, 'imageId')) }), card: shotCard },

  bot_remember: { family: 'bot', icon: 'spark', verbs: ['Remembering', 'Remembered'], row: f => ({ object: `“${clip(field(f, 'content'), 80)}”` }), card: f => beyond(field(f, 'content'), 80, 400) },
  bot_forget: { family: 'bot', icon: 'trash', verbs: ['Forgetting memory', 'Forgot memory'], row: f => ({ chip: chip(shortId(field(f, 'memoryId')), 'spark', field(f, 'memoryId')) }), card: rowOnly },
  bot_recall: { family: 'bot', icon: 'spark', verbs: ['Recalling memories', 'Recalled memories'], row: (_, o) => ({ object: objects(o.obj.memories).length || Array.isArray(o.json) ? `· ${count(Array.isArray(o.json) ? o.json.length : objects(o.obj.memories).length, 'memory', 'memories')}` : '' }), card: itemsCard('memories', ['content'], []) },
  bot_schedule: { family: 'bot', icon: 'activity', verbs: ['Scheduling', 'Scheduled'], row: f => ({ object: clip(field(f, 'title', 'prompt'), 60) + (field(f, 'kind') ? ` · ${field(f, 'kind')}${field(f, 'timeOfDay') ? ` ${field(f, 'timeOfDay')}` : ''}` : '') }), card: f => (field(f, 'title') ? label('Prompt', prose(field(f, 'prompt'), 400)) : beyond(field(f, 'prompt'), 60, 400)) + kvTable(rest(f, ['title', 'prompt', 'kind', 'timeOfDay']), 'Timing') },
  bot_list_schedules: { family: 'bot', icon: 'activity', verbs: ['Listing schedules', 'Listed schedules'], card: itemsCard('schedules', ['title', 'prompt'], ['kind', 'timeOfDay', 'intervalMinutes']) },
  bot_cancel_schedule: { family: 'bot', icon: 'stop', verbs: ['Cancelling schedule', 'Cancelled schedule'], row: f => ({ chip: chip(shortId(field(f, 'scheduleId')), 'activity', field(f, 'scheduleId')) }), card: rowOnly },
  bot_notify: { family: 'bot', icon: 'chat', verbs: ['Messaging the user', 'Messaged the user'], row: f => ({ object: clip(field(f, 'text'), 80) }), card: f => field(f, 'text').length > 80 ? bubble('bot', 'you', field(f, 'text')) : '' },
  bot_anything_else: { family: 'bot', icon: 'chat', verbs: ['Checking in', 'Checked in'] },

  jev_test: { family: 'jev', icon: 'activity', verbs: ['Starting browser test', 'Started browser test'], row: f => ({ chip: field(f, 'url') ? chip(host(field(f, 'url')), 'globe', field(f, 'url')) : undefined, object: clip(field(f, 'goal'), 80) }), card: (f, o) => beyond(field(f, 'goal'), 80, 400) + kvTable(rest(f, ['url', 'goal', 'taskId']), 'Checks') + (o.text.trim() ? reportCard(f, o) : '') },
  jev_read: { family: 'jev', icon: 'activity', verbs: ['Reading test report', 'Read test report'], row: f => ({ chip: chip(shortId(field(f, 'runId')), 'activity', field(f, 'runId')) }), card: reportCard },
  jev_wait: { family: 'jev', icon: 'activity', verbs: ['Waiting for test', 'Waited for test'], row: f => ({ chip: chip(shortId(field(f, 'runId')), 'activity', field(f, 'runId')) }), card: reportCard },
  jev_list: { family: 'jev', icon: 'activity', verbs: ['Listing test reports', 'Listed test reports'], card: itemsCard('reports', ['goal', 'url'], ['url']) },
  jev_screenshot: { family: 'jev', icon: 'camera', verbs: ['Viewing test screenshot', 'Viewed test screenshot'], row: f => ({ chip: chip(shortId(field(f, 'runId')), 'activity', field(f, 'runId')) }), card: shotCard },
  jev_cancel: { family: 'jev', icon: 'stop', verbs: ['Stopping browser test', 'Stopped browser test'], row: f => ({ chip: chip(shortId(field(f, 'runId')), 'activity', field(f, 'runId')) }), card: rowOnly },
  jev_review: { family: 'jev', icon: 'check', verbs: ['Reviewing work with Jev', 'Reviewed work with Jev'], card: reportCard },
  jev_check_rules: { family: 'jev', icon: 'check', verbs: ['Checking rules', 'Checked rules'], card: reportCard },
  jev_find_context: { family: 'jev', icon: 'search', verbs: ['Finding context', 'Found context'], row: f => ({ object: clip(field(f, 'query', 'question'), 80) }), card: reportCard },
  jev_choose_worker: { family: 'jev', icon: 'bot', verbs: ['Choosing a worker', 'Chose a worker'], card: reportCard },
  jev_assessments: { family: 'jev', icon: 'activity', verbs: ['Reading assessments', 'Read assessments'], card: reportCard },
};

function out(output: string): Out {
  const json = parseJson(output);
  return { json, obj: isObj(json) ? json : {}, text: output };
}

/** The tool's family (team, vm, …) for summaries and tints; undefined for non-PandaCode tools. */
export function pandacodeFamily(name: string): PandaFamily | undefined {
  const tool = pandacodeTool(name);
  return tool ? CATALOG[tool]?.family : undefined;
}

// --- Machine orchestration (docs/machine-orchestration.md) -------------------

export type MachineResult = { thread?: string; machine?: string; status?: string; linked?: boolean; pending?: boolean };
/** What a PandaCode machine tool returned (`{ thread, machine: { name }, status }`, or `{ linked, pending }` for a link). */
export function machineResult(output: string): MachineResult {
  const start = output.indexOf('{'), end = output.lastIndexOf('}');
  if (start < 0 || end <= start) return {};
  try {
    const value: unknown = JSON.parse(output.slice(start, end + 1));
    if (!isObj(value)) return {};
    const { thread, machine, status, linked, pending } = value;
    const name = typeof machine === 'string' ? machine : isObj(machine) && typeof machine.name === 'string' ? machine.name : undefined;
    const str = (item: unknown) => typeof item === 'string' ? item : undefined;
    return { thread: str(thread), machine: name, status: str(status), linked: linked === true, pending: pending === true };
  } catch { return {}; }
}

/** `Starting a thread on ProMini`-style rows for the `machine_*` tools. */
function machineTrace(tool: string, fields: Fields, output: string, running: boolean): { verb: string; object: string } | undefined {
  const tense = (now: string, done: string) => running ? now : done;
  const result = machineResult(output), name = result.machine ?? field(fields, 'machine'), threads = Array.isArray(fields.threads) ? fields.threads.length : 0;
  const on = name ? clip(name, 40) : '';
  switch (tool) {
    case 'list': return { verb: tense('Listing', 'Listed'), object: 'machines' };
    case 'link':
      // The tool returns after ~40 s with `pending` while the card still waits for the user.
      if (!running && result.pending) return { verb: 'Waiting for you', object: 'to link a machine' };
      if (!running && result.linked) return { verb: 'Linked', object: on || 'a machine' };
      return { verb: tense('Asking', 'Asked'), object: `to link ${on || 'a machine'}` };
    case 'capabilities': return { verb: tense('Checking', 'Checked'), object: `orchestration capabilities${on ? ` on ${on}` : ''}` };
    case 'launch': return { verb: running ? 'Launching' : result.status === 'starting' ? 'Starting' : 'Launched', object: `a thread on ${on || 'another machine'}${field(fields, 'title') ? ` · ${clip(field(fields, 'title'), 60)}` : ''}` };
    case 'wait': return { verb: tense('Waiting on', 'Waited on'), object: threads ? count(threads, 'thread') : 'threads' };
    case 'read': return { verb: tense('Reading', 'Read'), object: 'a thread' };
    case 'stop': return { verb: tense('Stopping', 'Stopped'), object: `a thread${on ? ` on ${on}` : ''}` };
    case 'message': return field(fields, 'action') === 'steer' ? { verb: tense('Steering', 'Steered'), object: 'a thread' } : { verb: tense('Messaging', 'Messaged'), object: 'a thread' };
    default: return;
  }
}

/** Row parts for a known PandaCode tool; undefined lets the caller use the generic `Used [PandaCode] tool` row. */
export function pandacodeTrace(tool: string, fields: Fields, output: string, running: boolean): Omit<Trace, 'kind'> | undefined {
  const machine = tool.startsWith('machine_') ? machineTrace(tool.slice(8), fields, output, running) : undefined;
  if (machine) return { ...machine, chip: { icon: 'server', label: 'PandaCode', title: tool }, family: 'cloud', icon: 'server' };
  const spec = CATALOG[tool];
  if (!spec) return;
  const row = spec.row?.(fields, out(output)) ?? {};
  const verbs = row.verbs ?? spec.verbs;
  return { verb: verbs[running ? 0 : 1], chip: row.chip, object: row.object ?? '', mono: row.mono, family: spec.family, icon: spec.icon };
}

/** Result card for a known PandaCode tool; failures lead with the error. Undefined for unknown tools. */
export function pandacodeCard(tool: string, fields: Fields, output: string, status: Status): string | undefined {
  const spec = CATALOG[tool];
  if (!spec) return;
  const parsed = out(output);
  const error = status === 'failed' && output.trim() && !parsed.json ? `${output.length > 400 ? PARTIAL : ''}<p class="tool-trace-note is-error">${escape(clip(output, 400))}</p>` : '';
  const body = spec.card ? spec.card(fields, error ? { json: undefined, obj: {}, text: '' } : parsed, status) : error ? '' : resultCard(output);
  return error + body;
}

export const PANDACODE_TOOLS = Object.keys(CATALOG);
