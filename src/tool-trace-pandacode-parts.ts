import type { ToolActivity } from './types';
import { escape, icon } from './dom.ts';
import {
  COMPLETE, PARTIAL, badge, basename, clip, clipText, domain, excerptCard, field, kvTable, lines, list, resultCard, searchCard, section, terminalCard, text,
  parseJson, type Fields, type ListItem, type TraceChip,
} from './tool-trace.ts';
import { salvageFields } from './tool-fields.ts';
import { ROW_TEXT } from './tool-text.ts';

/* Row and card builders for PandaCode's own MCP tools; the catalog (tool-trace-pandacode-catalog.ts) wires them per tool. Pure and escaped. */
export type PandaFamily = 'team' | 'task' | 'vm' | 'simulator' | 'design' | 'browser' | 'cloud' | 'code' | 'moodboard' | 'bot' | 'jev' | 'meta';
export type Status = ToolActivity['status'];
export type Out = { json: unknown; obj: Fields; text: string };
/** `note` is free text (a summary, a prompt), drawn after the sentence as a muted quote. */
export type Row = { chip?: TraceChip; object?: string; note?: string; mono?: boolean; verbs?: [string, string] };
export type Spec = { family: PandaFamily; icon: string; verbs: [string, string]; row?: (f: Fields, o: Out) => Row; card?: (f: Fields, o: Out, status: Status) => string };

// --- Small builders ---------------------------------------------------------

export function isObj(value: unknown): value is Fields { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
export function objects(value: unknown): Fields[] { return Array.isArray(value) ? value.filter(isObj) : []; }
export function count(n: number, one: string, many = one + 's'): string { return `${n} ${n === 1 ? one : many}`; }
export function chip(label: string, iconName: string, title = label): TraceChip | undefined {
  return label ? { icon: iconName, label: clip(label, 40), title } : undefined;
}
/** Short meta values joined by the one separator, empty ones left out. */
export function meta(...parts: string[]): string { return parts.filter(Boolean).join(' · '); }
/** A quiet tag beside a roster name or a status. */
export function quiet(text: string): string { return `<span class="tool-trace-badge is-quiet">${escape(text)}</span>`; }
export function shortId(id: string): string { return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id) ? id.slice(0, 8) : id; }
export function prose(value: string, limit = 600): string {
  return value.trim() ? `${value.length > limit ? PARTIAL : ''}<p class="tool-trace-prose">${escape(clipText(value, limit))}</p>` : '';
}
export function note(value: string): string { return value.trim() ? `${value.length > 240 ? PARTIAL : ''}<p class="tool-trace-note">${escape(clip(value, 240))}</p>` : ''; }
export const label = section;
/** The full text only when the row clipped it; otherwise the row already says everything. */
export function beyond(value: string, shown: number, limit = 600): string { return value.length > shown ? prose(value, limit) : ''; }
/** Fields the row did not already show. */
export function rest(f: Fields, shown: string[]): Fields {
  return Object.fromEntries(Object.entries(f).filter(([key]) => !shown.includes(key)));
}
export function files(paths: unknown, limit = 4): string {
  const all = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [];
  if (!all.length) return '';
  const more = all.length > limit ? `<span class="tool-trace-more">+${all.length - limit}</span>` : '';
  return `<span class="tool-trace-files">${all.slice(0, limit).map(p => `<code title="${escape(p)}">${escape(clip(p, 48))}</code>`).join('')}${more}</span>`;
}
export function bubble(from: string, to: string, message: string, meta = ''): string {
  const who = (name: string) => `<b${shortId(name) !== name ? ` title="${escape(name)}"` : ''}>${escape(clip(shortId(name), 40))}</b>`;
  const route = `${who(from || 'you')}${to ? `<span aria-hidden="true">→</span>${who(to)}` : ''}`;
  const metaHtml = meta ? `<span class="tool-trace-card-meta">${escape(meta)}</span>` : '';
  return `<div class="tool-trace-bubble"><div class="tool-trace-bubble-head">${route}${metaHtml}</div>${prose(message, 500)}</div>`;
}
export function time(value: unknown): string {
  const n = typeof value === 'number' ? value : 0;
  if (!n) return '';
  const date = new Date(n < 1e12 ? n * 1000 : n);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(11, 16);
}
export function host(url: string): string {
  try { const parsed = new URL(url); return parsed.port ? `${parsed.hostname}:${parsed.port}` : domain(url); } catch { return clip(url, 60); }
}
export function isLocal(url: string): boolean { return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url); }
export function size(bytes: unknown): string {
  return typeof bytes === 'number' ? bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} kB` : '';
}

// --- Workers and teams ------------------------------------------------------

export function route(worker: Fields): string {
  const model = [field(worker, 'provider'), field(worker, 'model')].filter(Boolean).join(' · ') || field(worker, 'profileId');
  return [model, field(worker, 'reasoningEffort')].filter(Boolean).join(' · ');
}
export function roster(workers: Fields[], statusOf: (worker: Fields, index: number) => string = worker => field(worker, 'status')): string {
  if (!workers.length) return '';
  const rows = workers.slice(0, 12).map((worker, index) => {
    const name = field(worker, 'name', 'key', 'id', 'workerId') || `Worker ${index + 1}`;
    const body = field(worker, 'summary', 'prompt', 'error');
    const depends = Array.isArray(worker.dependsOn) && worker.dependsOn.length ? `after ${worker.dependsOn.join(', ')}` : '';
    const meta = [route(worker), depends].filter(Boolean).join(' · ');
    const routeHtml = meta ? `<span class="tool-trace-route">${escape(clip(meta, 80))}</span>` : '';
    const tags = (worker.you === true ? quiet('you') : '') + (worker.readOnly === true ? quiet('read-only') : '');
    const head = `<div class="tool-trace-roster-head">${icon('bot')}<b>${escape(clip(name, 60))}</b>${routeHtml}${tags}${badge(statusOf(worker, index))}</div>`;
    return `<li>${head}${body ? `<p class="tool-trace-roster-text">${escape(clip(body, 220))}</p>` : ''}${files(worker.files)}</li>`;
  }).join('');
  const more = workers.length > 12 ? `<li class="tool-trace-more">+${workers.length - 12} more</li>` : '';
  return `<ul class="tool-trace-roster">${rows}${more}</ul>`;
}
export function assignments(f: Fields): Fields[] {
  return [f.assignments, f.workers, f.tasks].map(objects).find(list => list.length) ?? [];
}
export function dispatchCard(f: Fields, o: Out): string {
  const ids = Array.isArray(o.obj.workerIds) ? o.obj.workerIds : [];
  const status = (_: Fields, i: number) => { const id = ids[i]; return isObj(id) ? field(id, 'status') : ids.length ? 'queued' : ''; };
  const workers = assignments(f);
  return (workers.length ? roster(workers, status) : roster(objects(ids))) + note(field(o.obj, 'note'));
}
export function messages(o: Out): string {
  const all = objects(o.obj.messages);
  if (!all.length) return Array.isArray(o.obj.messages) ? note('No new messages.') : '';
  return all.slice(-6).map(m => bubble(field(m, 'sender', 'from', 'role'), field(m, 'recipient', 'to'), field(m, 'message', 'content', 'text'), time(m.createdAt))).join('')
    + (all.length > 6 ? `<p class="tool-trace-more">+${all.length - 6} earlier</p>` : '');
}
/** The worker a team call names: its name when the record carries one, else a short id with the full id on hover. */
export function worker(f: Fields, o?: Out): TraceChip | undefined {
  const id = field(f, 'workerId', 'recipient', 'to') || (o ? field(o.obj, 'workerId') : '');
  const name = (o ? field(o.obj, 'name', 'workerName') : '') || field(f, 'workerName', 'name');
  return chip(name || shortId(id), 'bot', id || name);
}
export const WORKER_ID = /^[0-9a-f]{8}(?:-[0-9a-f-]+)?$/i;
/** `Read worker 2118342a's report`: a bare id reads as one possessive phrase (a chip before `'s` would split it); a named
 *  worker keeps its chip (`Read [Rows: titles] report`), whose name may not take a possessive. */
export function reportRow(f: Fields, o?: Out, role = 'worker'): Row {
  const id = field(f, 'workerId', 'recipient', 'to') || (o ? field(o.obj, 'workerId') : '');
  const name = (o ? field(o.obj, 'name', 'workerName') : '') || field(f, 'workerName', 'name');
  if (name) return { chip: worker(f, o), object: 'report' };
  return { object: id ? `${role} ${clip(shortId(id), 40)}'s report` : `a ${role}'s report` };
}
/** `Messaged [Rows]`, `Messaged worker [9b326e2a]` for a bare id, `Sent team message` when nobody is named. */
export function sendRow(f: Fields, o: Out): Row {
  // The gist of what was said, like a checkpoint's summary.
  const gist = clip(field(f, 'message', 'text', 'body'), GIST_LIMIT);
  return { ...sendTarget(f, o), ...(gist ? { note: gist } : {}) };
}
const GIST_LIMIT = ROW_TEXT;
function sendTarget(f: Fields, o: Out): Row {
  const id = field(f, 'workerId', 'recipient', 'to') || field(o.obj, 'recipient');
  const name = field(o.obj, 'name', 'workerName') || field(f, 'workerName', 'name');
  if (name) return { chip: chip(name, 'bot', id || name) };
  if (!id) return { verbs: ['Sending team message', 'Sent team message'] };
  return WORKER_ID.test(id) ? { verbs: ['Messaging worker', 'Messaged worker'], chip: chip(shortId(id), 'bot', id) } : { chip: chip(id, 'bot') };
}
/** `Followed up with [Rows] · “…”`; a record cut before its `workerId` (the prompt filled it) still says who it went to. */
export function followupRow(f: Fields, o: Out): Row {
  const who = worker(f, o);
  return { ...(who ? { chip: who } : { object: 'a worker' }), note: clip(field(f, 'prompt'), ROW_TEXT) };
}
export const readCard = (_: Fields, o: Out): string =>
  `<div class="tool-trace-card-head">${badge(field(o.obj, 'status'))}${o.obj.readOnly === true ? quiet('read-only') : ''}</div>`
  + label('Summary', prose(field(o.obj, 'summary'), 400)) + label('Response', prose(field(o.obj, 'response'), 500)) + files(o.obj.files);
export function listCard(_: Fields, o: Out): string {
  const of = typeof o.obj.maxRounds === 'number' ? ` of ${o.obj.maxRounds}` : '';
  return (typeof o.obj.round === 'number' ? note(`Round ${o.obj.round}${of}`) : '') + roster(objects(o.obj.workers));
}
export const workerCount = (o: Out): string => objects(o.obj.workers).length ? count(objects(o.obj.workers).length, 'worker') : 'workers';

/** `pandacode_sub_workers`: one tool whose `action` lists, reads, follows up with or cancels a sub-worker. */
export const SUB_VERBS: Record<string, [string, string]> = {
  read: ['Reading', 'Read'], followup: ['Following up with sub-worker', 'Followed up with sub-worker'],
  cancel: ['Cancelling sub-worker', 'Cancelled sub-worker'],
};
export function subWorkersRow(f: Fields, o: Out): Row {
  const act = field(f, 'action');
  if (act === 'list' || !SUB_VERBS[act]) return { object: o.json ? `· ${workerCount(o)}` : '' };
  if (act === 'read') return { verbs: ['Reading', 'Read'], ...reportRow(f, o, 'sub-worker') };
  return { verbs: SUB_VERBS[act], chip: worker(f, o), note: clip(field(f, act === 'cancel' ? 'reason' : 'prompt'), ROW_TEXT) };
}
export function subWorkersCard(f: Fields, o: Out): string {
  const act = field(f, 'action');
  if (act === 'read') return readCard(f, o);
  if (act === 'followup') return beyond(field(f, 'prompt'), 80) + (o.json ? '' : note(o.text)) || COMPLETE;
  if (act === 'cancel') return beyond(field(f, 'reason'), 80) || COMPLETE;
  return listCard(f, o);
}

// --- Progress snapshots and model routing -----------------------------------

export const MARK_TONES = /^(success|warning|danger|error|info)$/;
export const MARK_LIMIT = 8;
/** A snapshot's annotations as labels with a small tone dot; the shape (`box`, `arrow`) is the image's business. */
export function snapshotMarks(annotations: unknown): string {
  const marks = objects(annotations).map(a => ({ label: field(a, 'label', 'text'), tone: field(a, 'tone') })).filter(mark => mark.label);
  if (!marks.length) return '';
  const dot = (tone: string) => `<span class="tool-trace-mark-dot" data-mark-tone="${MARK_TONES.test(tone) ? tone : 'neutral'}"></span>`;
  const rows = marks.slice(0, MARK_LIMIT).map(({ label, tone }) => `<li>${dot(tone)}${escape(clip(label, 120))}</li>`).join('');
  const more = marks.length > MARK_LIMIT ? `<li class="tool-trace-more">+${marks.length - MARK_LIMIT} more</li>` : '';
  const clipped = marks.length > MARK_LIMIT || marks.some(mark => mark.label.length > 120);
  return `${clipped ? PARTIAL : ''}<ul class="tool-trace-marks">${rows}${more}</ul>`;
}
export function snapshotCard(f: Fields, o: Out): string {
  const saved = isObj(o.obj.saved) ? o.obj.saved : {};
  return prose(field(f, 'note') || field(saved, 'note'), 400) + snapshotMarks(f.annotations) || COMPLETE;
}

/** The team directory's members. Its record is cut at 8 KB, so a cut one keeps the members read before the cut,
 *  less a last one that the cut went through (fewer keys than the first). */
export function teamMembers(o: Out): { workers: Fields[]; cut: boolean } {
  const whole = objects(o.obj.workers);
  if (whole.length || o.json !== undefined) return { workers: whole, cut: false };
  const read = objects(salvageFields(o.text)?.workers).filter(worker => field(worker, 'name', 'id'));
  const last = read[read.length - 1];
  const workers = read.length > 1 && last && Object.keys(last).length < Object.keys(read[0]).length ? read.slice(0, -1) : read;
  return { workers, cut: workers.length > 0 };
}
export function directoryCard(_: Fields, o: Out): string {
  const { workers, cut } = teamMembers(o);
  const you = field(o.obj, 'you');
  const marked = workers.map(worker => you && field(worker, 'id') === you ? { ...worker, you: true } : worker);
  return (cut ? PARTIAL : '') + roster(marked);
}
export function directoryRow(_: Fields, o: Out): Row {
  const { workers, cut } = teamMembers(o);
  return { object: workers.length ? `· ${workers.length}${cut ? '+' : ''} ${workers.length === 1 && !cut ? 'teammate' : 'teammates'}` : '' };
}
export type Pick = { text: string; pick: Fields; category: string };
/** Each routed task with the model picked for it; the answer's tasks line up with the request's. */
export function picks(f: Fields, o: Out): Pick[] {
  const asked = objects(f.tasks);
  return objects(o.obj.tasks).map((t, i) => ({ text: field(asked[i] ?? {}, 'text', 'prompt', 'title'), pick: isObj(t.pick) ? t.pick : {}, category: field(t, 'category') }));
}
export function routeRow(f: Fields, o: Out): Row {
  const all = picks(f, o);
  const one = all.length === 1 ? field(all[0].pick, 'name', 'model') : '';
  return { object: one ? `· ${clip(one, ROW_TEXT)}` : all.length ? `· ${count(all.length, 'task')}` : '' };
}
export function routeCard(f: Fields, o: Out): string {
  const all = picks(f, o);
  if (!all.length) return resultCard(o.text);
  const odds = (p: Fields) => typeof p.pSuccess === 'number' ? `${Math.round(p.pSuccess * 100)}%` : '';
  const item = ({ text: task, pick, category }: Pick): ListItem => ({ title: task || category || 'Task', meta: meta(field(pick, 'name', 'model'), odds(pick)), badge: category });
  return list(all.map(item), all.length);
}

// --- Tasks ------------------------------------------------------------------

export function taskItem(task: Fields, withText = true): ListItem {
  const text = withText ? field(task, 'excerpt', 'description') : '';
  const title = field(task, 'title') || shortId(field(task, 'id')) || 'Task';
  return { title, meta: meta(field(task, 'provider'), field(task, 'model'), text), hint: field(task, 'id'), badge: field(task, 'stage', 'status') };
}
export function taskCard(f: Fields, o: Out): string {
  const many = objects(o.obj.tasks);
  if (many.length) return list(many.map(t => taskItem(t)), many.length);
  const one = isObj(o.obj.task) ? o.obj.task : field(o.obj, 'id', 'title') ? o.obj : field(f, 'title') ? f : undefined;
  if (!one) return '';
  const history = objects(o.obj.messages);
  // The row already names the task: show only what it lacks.
  const item = taskItem(one, false);
  const lead = item.meta || item.badge ? `<p class="tool-trace-note">${item.badge ? badge(item.badge) + ' ' : ''}${escape(item.meta ?? '')}</p>` : '';
  const read = history.length ? note(`${count(history.length, 'message')} read${o.obj.hasOlder === true ? ', older ones remain' : ''}`) : '';
  return lead + prose(field(one, 'description') || field(f, 'description'), 300) + read;
}
export const task = (f: Fields, o: Out): TraceChip | undefined => {
  const title = field(o.obj, 'title') || (isObj(o.obj.task) ? field(o.obj.task, 'title') : '');
  return chip(title || shortId(field(f, 'taskId')) || '', 'board', field(f, 'taskId'));
};

// --- Machines ---------------------------------------------------------------

export function machines(o: Out): ListItem[] {
  const state = (vm: Fields) => vm.running === true ? 'running' : vm.running === false ? 'stopped' : field(vm, 'state');
  const local = objects(o.obj.vms).map(vm => ({ title: field(vm, 'name'), meta: meta('local', vm.diskGb ? `${vm.diskGb} GB` : ''), badge: state(vm) }));
  const cloud = objects(o.obj.cloud).map(vm => ({
    title: field(vm, 'name', 'id'), meta: meta(field(vm, 'provider'), field(vm, 'os'), vm.desktop === true ? 'desktop' : ''),
    hint: field(vm, 'id'), badge: field(vm, 'state'),
  }));
  return [...local, ...cloud];
}
export function machineCard(_: Fields, o: Out): string {
  const all = machines(o);
  return (all.length ? list(all, all.length) : note('No machines yet.')) + note(field(o.obj, 'engine'));
}
export function deviceCard(_: Fields, o: Out): string {
  const devices = objects(o.obj.devices);
  const runtime = (d: Fields) => field(d, 'runtime').replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '').replace(/^([A-Za-z]+)-(\d+)-(\d+)$/, '$1 $2.$3');
  const item = (d: Fields): ListItem => ({
    title: field(d, 'name'), meta: meta(runtime(d), field(o.obj, 'shown') === field(d, 'udid') ? 'shown' : ''), hint: field(d, 'udid'), badge: field(d, 'state'),
  });
  return list(devices.map(item), devices.length)
    + note(field(o.obj, 'touchInput').startsWith('missing') ? `Touch input ${field(o.obj, 'touchInput')}` : '');
}
export function point(f: Fields, x = 'x', y = 'y'): string { return typeof f[x] === 'number' && typeof f[y] === 'number' ? `(${f[x]}, ${f[y]})` : ''; }
/** `Clicked at (420, 88)`, `Typed “hello”`, `Pressed cmd+space` from a computer-use action. */
export function action(f: Fields): Row {
  const act = field(f, 'action');
  const typed = clip(field(f, 'text'), ROW_TEXT);
  switch (act) {
    case 'type': return { verbs: ['Typing', 'Typed'], object: typed ? `“${typed}”` : '' };
    case 'key': return { verbs: ['Pressing', 'Pressed'], object: field(f, 'keys', 'key'), mono: true };
    case 'button': return { verbs: ['Pressing', 'Pressed'], object: `${field(f, 'button')} button` };
    case 'scroll': return { verbs: ['Scrolling', 'Scrolled'], object: [field(f, 'direction'), point(f)].filter(Boolean).join(' at ') };
    case 'swipe': return { verbs: ['Swiping', 'Swiped'], object: [point(f), point(f, 'endX', 'endY')].filter(Boolean).join(' → ') };
    case 'drag': return { verbs: ['Dragging', 'Dragged'], object: [point(f), point(f, 'endX', 'endY')].filter(Boolean).join(' → ') };
    case 'move': return { verbs: ['Moving pointer', 'Moved pointer'], object: point(f) ? `to ${point(f)}` : '' };
    case 'tap_label': return { verbs: ['Tapping', 'Tapped'], object: `“${clip(field(f, 'label'), ROW_TEXT)}”` };
    default: return POINTER[act] ? { verbs: POINTER[act], object: point(f) ? `at ${point(f)}` : '' } : {};
  }
}
export const POINTER: Record<string, [string, string]> = {
  click: ['Clicking', 'Clicked'], double_click: ['Double-clicking', 'Double-clicked'],
  right_click: ['Right-clicking', 'Right-clicked'], middle_click: ['Middle-clicking', 'Middle-clicked'],
  tap: ['Tapping', 'Tapped'], double_tap: ['Double-tapping', 'Double-tapped'], long_press: ['Long-pressing', 'Long-pressed'],
};
export const ACTION_SHOWN = ['name', 'udid', 'action', 'x', 'y', 'endX', 'endY', 'direction', 'keys', 'key', 'button', 'label', 'screenshot'];
/** Only what the row did not say: long typed text, extra options, and any text result. */
export function actionCard(f: Fields, o: Out): string {
  const extra = rest(f, [...ACTION_SHOWN, 'text']);
  return beyond(field(f, 'text'), 50, 2000) + kvTable(extra, 'Options') + (o.text.trim() && !o.json ? note(o.text) : o.json ? resultCard(o.text) : '');
}
export const shotCard = (_: Fields, o: Out): string => o.json ? '' : note(o.text);
export const MANAGE: Record<string, [string, string]> = {
  create: ['Creating', 'Created'], start: ['Starting', 'Started'], stop: ['Stopping', 'Stopped'], suspend: ['Suspending', 'Suspended'], delete: ['Deleting', 'Deleted'],
  show: ['Showing', 'Showed'], install_desktop: ['Installing desktop on', 'Installed desktop on'], boot: ['Booting', 'Booted'], shutdown: ['Shutting down', 'Shut down'],
  install: ['Installing app on', 'Installed app on'], launch: ['Launching', 'Launched'], terminate: ['Quitting', 'Quit'], open_url: ['Opening link on', 'Opened link on'],
  appearance: ['Switching appearance of', 'Switched appearance of'], pose: ['Folding', 'Folded'],
};
export function manage(noun: string, target: (f: Fields) => string, iconName: string) {
  return (f: Fields): Row => {
    const act = field(f, 'action');
    const what = target(f);
    const object = act === 'install' ? basename(field(f, 'path'))
      : field(f, 'image') ? `from ${field(f, 'image')}` : field(f, 'provider') ? `on ${field(f, 'provider')}`
      : field(f, 'appearance', 'pose') ? `to ${field(f, 'appearance', 'pose')}` : field(f, 'bundleId', 'url');
    return { verbs: MANAGE[act] ?? ['Managing', 'Managed'], chip: chip(what || noun, iconName), object };
  };
}
export const MANAGE_SHOWN = ['action', 'name', 'udid', 'path', 'image', 'provider', 'appearance', 'pose', 'bundleId', 'url'];
export const manageCard = (f: Fields, o: Out): string => kvTable(rest(f, MANAGE_SHOWN), 'Options') + (o.text.trim() ? resultCard(o.text) : '');
export const machine = (f: Fields): string => field(f, 'name');
export const device = (f: Fields): string => shortId(field(f, 'udid'));
/** `iPhone Duo (iOS 27.1, CDDA7229-…). Screen …`: the simulator tool names the device it acted on first in its output. */
const SIM_DEVICE = /^([^\n(]{1,60}?) \((?:iOS|iPadOS|watchOS|tvOS|visionOS|xrOS)\b[^\n)]*\)/;
/** The device a simulator call acted on: its name from the output, else the udid it was given (shortened). */
export const simDevice = (f: Fields, o: Out): string => SIM_DEVICE.exec(o.text.trim())?.[1]?.trim() || device(f);

// --- Design, browser, code, cloud -------------------------------------------

export function artboard(name: string): string { return name.replace(/\.html?$/i, ''); }
export function artboardCard(_: Fields, o: Out): string {
  const boards = objects(o.obj.artboards);
  const open = typeof o.obj.openComments === 'number' ? o.obj.openComments : 0;
  return list(boards.map(b => ({ title: artboard(field(b, 'name')), meta: [size(b.size), field(b, 'path')].filter(Boolean).join(' · '), hint: field(b, 'path') })), boards.length)
    + (boards.length ? '' : note('No artboards yet.')) + (open ? note(`${count(open, 'open comment')}`) : '');
}
export function commentCard(_: Fields, o: Out): string {
  const all = objects(o.obj.comments);
  const item = (c: Fields): ListItem => ({ title: field(c, 'text'), meta: meta(artboard(field(c, 'artboard')), field(c, 'selector')), badge: field(c, 'status') });
  return all.length ? list(all.map(item), all.length) : note('No comments.');
}
export function serverCard(_: Fields, o: Out): string {
  const all = Array.isArray(o.json) ? objects(o.json) : objects(o.obj.servers);
  const item = (s: Fields): ListItem => ({ title: `:${s.port ?? ''}`, meta: meta(field(s, 'process'), field(s, 'url')), hint: field(s, 'url') });
  return all.length ? list(all.map(item), all.length) : note('No local servers are listening.');
}
export function pageCard(_: Fields, o: Out): string {
  const url = field(o.obj, 'url');
  return (url ? list([{ title: field(o.obj, 'title') || host(url), meta: url, hint: url }]) : '')
    + (field(o.obj, 'text') ? prose(field(o.obj, 'text'), 400) : url ? '' : resultCard(o.text));
}
export function codeCard(f: Fields, o: Out): string {
  const results = field(o.obj, 'results') || (o.json ? '' : o.text);
  return (results ? searchCard(results) : note(`No matches for ${field(f, 'query')}.`)) + (o.obj.truncated === true ? note('Results were truncated.') : '');
}
export function trackCard(f: Fields, o: Out): string {
  const paths = Array.isArray(f.paths) ? f.paths.filter((p): p is string => typeof p === 'string') : [];
  const capture = field(o.obj, 'captureId');
  const item = (p: string): ListItem => ({ title: basename(p), meta: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '', hint: capture ? `${p} · capture ${capture}` : p });
  return list(paths.map(item), paths.length);
}
export function cloudCard(f: Fields, o: Out, status: Status): string {
  return terminalCard(`${field(f, 'tool')} ${field(f, 'args')}`.trim(), o.text, status) + (o.obj.truncated === true ? note('Output was truncated.') : '');
}
export function itemsCard(key: string, titleKeys: string[], metaKeys: string[]) {
  return (_: Fields, o: Out): string => {
    const all = Array.isArray(o.json) ? objects(o.json) : objects(o.obj[key]);
    const value = (item: Fields, k: string) => text(item[k]) || (typeof item[k] === 'number' ? String(item[k]) : '');
    const row = (item: Fields): ListItem => ({
      title: field(item, ...titleKeys) || shortId(field(item, 'id')), meta: meta(...metaKeys.map(k => value(item, k))),
      hint: field(item, 'id'), badge: field(item, 'status', 'state'),
    });
    return all.length ? list(all.map(row), all.length) : resultCard(o.text);
  };
}
export function reportCard(_: Fields, o: Out): string {
  const checks = objects(o.obj.checks);
  const head = [field(o.obj, 'status', 'verdict', 'outcome'), field(o.obj, 'summary', 'advice', 'recommendation')];
  if (!head[0] && !head[1] && !checks.length) return resultCard(o.text);
  const run = field(o.obj, 'runId') ? `<span class="tool-trace-card-meta">${escape(shortId(field(o.obj, 'runId')))}</span>` : '';
  const passed = (c: Fields) => c.passed === true ? 'passed' : c.passed === false ? 'failed' : field(c, 'status');
  const item = (c: Fields): ListItem => ({ title: field(c, 'name', 'label', 'check'), meta: field(c, 'detail', 'evidence'), badge: passed(c) });
  return (head[0] ? `<div class="tool-trace-card-head tool-trace-verdict">${badge(head[0])}${run}</div>` : '')
    + prose(head[1], 400) + list(checks.map(item), checks.length);
}

// --- Catalog ----------------------------------------------------------------

export const promptCard = (key: string) => (f: Fields, o: Out): string => label('Message', prose(field(f, key), 500)) + (o.json ? '' : excerptCard(o.text));

/** Mutations whose row says everything: no card unless they fail. */
export const rowOnly = (): string => COMPLETE;

/** "in 30 min", "at 18:30", "every 2 h", "weekdays at 09:00", "after another thread" from a schedule tool's input. */
export function scheduleTiming(f: Fields): string {
  const minutes = (value: unknown) => { const n = Number(value); return n < 60 ? `${n} min` : `${Math.round(n / 6) / 10} h`.replace('.0 ', ' '); };
  const time = field(f, 'timeOfDay'), kind = field(f, 'kind');
  if (kind === 'interval' && Number(f.intervalMinutes) > 0) return `every ${minutes(f.intervalMinutes)}`;
  if ((kind === 'daily' || kind === 'weekdays' || kind === 'weekly') && time) return `${kind} at ${time}`;
  if (kind === 'after' || field(f, 'afterTaskId')) return 'after another thread';
  if (Number(f.inMinutes) > 0) return `in ${minutes(f.inMinutes)}`;
  const at = field(f, 'at');
  if (/^\d{1,2}:\d{2}$/.test(at)) return `at ${at}`;
  const date = at ? new Date(at) : null;
  return date && !Number.isNaN(date.getTime()) ? `at ${date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : '';
}
/** The summary's first line, clipped; the card holds the rest. */
export function summaryLead(summary: string): string { return clip(summary.trim().split('\n', 1)[0] ?? '', ROW_TEXT); }
export const NOTE_VERBS: Record<string, [string, string]> = {
  set: ['Saving team note', 'Saved team note'], get: ['Reading team note', 'Read team note'], delete: ['Deleting team note', 'Deleted team note'],
};
/** `Saved team note [key]`, `Read team note [key]`, `Read team notes · 3 notes` by the call's action. */
export function noteRow(f: Fields, o: Out): Row {
  const verbs = NOTE_VERBS[field(f, 'action')];
  if (verbs) return { verbs, chip: chip(field(f, 'key'), 'pin') };
  const notes = objects(o.obj.notes);
  return { object: notes.length ? `· ${count(notes.length, 'note')}` : '' };
}
export function noteCard(f: Fields, o: Out): string {
  const action = field(f, 'action');
  if (action === 'set') return prose(field(f, 'value'), 600) || rowOnly();
  if (action === 'get') return prose(isObj(o.obj.note) ? field(o.obj.note, 'value') : '', 600) || note(o.obj.found === false ? 'No note with that key.' : '');
  const notes = objects(o.obj.notes);
  return notes.length ? list(notes.map(item => ({ title: field(item, 'key'), meta: field(item, 'author', 'value') })), notes.length) : rowOnly();
}
export const scheduleRow = (what: string) => (f: Fields): Row => ({ object: [what, scheduleTiming(f), clip(field(f, 'title', 'note', 'text'), ROW_TEXT)].filter(Boolean).join(' · ') });


export function out(output: string): Out {
  const json = parseJson(output);
  return { json, obj: isObj(json) ? json : {}, text: output };
}
