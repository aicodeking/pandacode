// Webview and preview twin of src-tauri/src/extensions/runtime_pending_requests.rs (runtime phase R5, slice R0507):
// pending approvals and questions as durable, observe-only hook events. Every request a run puts in front of the user
// is kept under one stable identity (its task and the `<run>:<harness id>` the app shows it under) and gives
// `approval.pending` / `question.pending` when it appears and `approval.resolved` / `question.resolved` when it ends,
// in every case: `user`, `{ package }`, `mode` (withdrawn by the harness after the task's mode changed) or `cancelled`.
// A duplicate or resumed frame opens nothing; a request that ended never opens again; nothing expires. A service that
// lost events rebuilds its list from `panda.hooks.pending()`, filtered like a live delivery. The same rules in the same
// order as the native module; the shared fixture is tests/fixtures/extensions/runtime-pending-requests/scenarios.json.
// It runs no harness.
import type { Json } from './runtime-hook-payload.ts';
import { kindOfInput, matches, toolKind, type Match, type Occurrence } from './runtime-hook-registration.ts';

type Obj = { [key: string]: Json };
const object = (value: Json | undefined): value is Obj => value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

export const EVENTS = ['approval.pending', 'approval.resolved', 'question.pending', 'question.resolved'] as const;
export const SCHEMA_VERSION = 1;
export const OPEN_PER_TASK = 64;
const OPEN_TOTAL = 4_096;
const CLOSED_PER_TASK = 256;
const CLOSED_TOTAL = 8_192;
export const TEXT_BYTES = 64 << 10;
export const INPUT_BYTES = 1 << 20;
export const SNAPSHOT_BYTES = (2 << 20) - (64 << 10);
const QUESTIONS = 64;
const ASKED_LIMIT = 1_024;

export type Kind = 'approval' | 'question';
export const pendingEvent = (kind: Kind) => kind === 'approval' ? 'approval.pending' : 'question.pending';
export const resolvedEvent = (kind: Kind) => kind === 'approval' ? 'approval.resolved' : 'question.resolved';
/** The app's agent event kinds: whether one opens or withdraws a request of which family. */
export function ofEvent(kind: string): [Kind, boolean] | null {
  switch (kind) {
    case 'approval': return ['approval', true];
    case 'approval_cancelled': return ['approval', false];
    case 'input_request': return ['question', true];
    case 'input_cancelled': return ['question', false];
    default: return null;
  }
}

export type By = 'user' | 'mode' | 'cancelled' | { package: string };
export interface Facts { project: string; harness: string; mode: string; run: string }
export interface Request { task: string; request: string; text: string; data: Json; call: string | null; input: Json | undefined; askAtHost: boolean; at: string }
export type Ending =
  | { kind: 'answered'; approved: boolean | null; response: Json | undefined }
  | { kind: 'withdrawn'; currentMode: string | null }
  | { kind: 'gone' };
export interface Change { event: string; facts: Facts; payload: Obj }
export const changeJson = (change: Change): Obj => ({ event: change.event, payload: change.payload });
/** The registry occurrence of a change: filtered by the run's project, harness and run kind like every hook event. */
export const occurrenceOf = (change: Change): Occurrence => ({ event: change.event as Occurrence['event'], project: change.facts.project, harness: change.facts.harness, run: change.facts.run, toolKind: null, paths: [], payload: change.payload });

// ---- Normalization -----------------------------------------------------------------------------------------------------

/** `text` cut back to at most `limit` UTF-8 bytes on a code point boundary. */
export function bounded(text: string, limit: number): string {
  if (byteLength(text) <= limit) return text;
  let used = 0;
  let end = 0;
  for (const character of text) {
    const width = byteLength(character);
    if (used + width > limit) break;
    used += width;
    end += character.length;
  }
  return text.slice(0, end);
}
/** The harness's own id of an app request id (`<run>:<id>`). */
export const localId = (request: string) => { const at = request.indexOf(':'); return at < 0 ? request : request.slice(at + 1); };
const nonEmpty = (value: Json | undefined): string | null => typeof value === 'string' && value !== '' ? value : null;
const field = (value: Json | undefined, key: string): Json | undefined => object(value) ? value[key] : undefined;

/** The tool a request asks about: the event's data names it, else the prompt's `Allow <tool>?` line. */
export function toolName(text: string, data: Json): string {
  const found = ['name', 'tool_name', 'title'].map(key => field(data, key)).find(value => typeof value === 'string') as string | undefined;
  if (found) return found;
  const line = text.split('\n')[0] ?? '';
  if (line.startsWith('Allow ')) {
    const name = line.slice('Allow '.length).split('?')[0].trim();
    if (name && byteLength(name) <= 128) return name;
  }
  return 'tool';
}

/** `PendingApproval`; `asked` is the package whose `ask` (or failing `ask` policy) put the prompt there. */
export function pendingApproval(request: Request, facts: Facts, asked: string | null): Obj {
  const name = toolName(request.text, request.data);
  let kind = toolKind(name);
  if (kind === 'other' && request.input !== undefined) kind = kindOfInput(request.input);
  const askedBy: Json = asked !== null ? { package: asked } : request.askAtHost ? 'mode' : 'harness';
  const payload: Obj = {
    requestId: request.request, taskId: request.task, projectId: facts.project, harness: facts.harness, mode: facts.mode,
    tool: { kind, name }, text: bounded(request.text, TEXT_BYTES), askedBy, at: request.at,
  };
  if (request.call !== null) payload.callId = request.call;
  if (request.input !== undefined && byteLength(JSON.stringify(request.input)) <= INPUT_BYTES) payload.input = request.input;
  return payload;
}

/** `PendingQuestion.questions` from core's normalized `input_request` data (see the native `questions_of`). */
export function questionsOf(text: string, data: Json): { questions: Obj[]; secret: Set<string>; structured: boolean } {
  const secret = new Set<string>();
  const question = (id: string, header: string | null, asked: string, options: Obj[] | null, multiple: boolean, hidden: boolean): Obj => {
    const out: Obj = { id, question: bounded(asked, TEXT_BYTES), multiple, secret: hidden };
    if (header !== null) out.header = bounded(header, TEXT_BYTES);
    if (options !== null) out.options = options;
    return out;
  };
  const kind = field(data, 'kind');
  if (kind === 'questions') {
    const out: Obj[] = [];
    const list = field(data, 'questions');
    for (const asked of (Array.isArray(list) ? list : []).slice(0, QUESTIONS)) {
      const id = field(asked, 'id');
      if (typeof id !== 'string') continue;
      const hidden = field(asked, 'isSecret') === true;
      if (hidden) secret.add(id);
      const rawOptions = field(asked, 'options');
      const options = Array.isArray(rawOptions) ? rawOptions.flatMap(option => {
        const label = field(option, 'label');
        if (typeof label !== 'string') return [];
        const entry: Obj = { label };
        const description = nonEmpty(field(option, 'description'));
        if (description !== null) entry.description = description;
        return [entry];
      }) : null;
      const text = field(asked, 'question');
      out.push(question(id, nonEmpty(field(asked, 'header')), typeof text === 'string' ? text : '', options, false, hidden));
    }
    return { questions: out, secret, structured: true };
  }
  if (kind === 'form') {
    const header = nonEmpty(field(data, 'message'));
    const out: Obj[] = [];
    const properties = field(field(data, 'schema'), 'properties');
    if (object(properties)) {
      // A JSON object's fields by name, the same order on both sides (UTF-16 order equals byte order for these names).
      for (const name of Object.keys(properties).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, QUESTIONS)) {
        const property = properties[name];
        const hidden = field(property, 'format') === 'password';
        if (hidden) secret.add(name);
        const asked = nonEmpty(field(property, 'title')) ?? nonEmpty(field(property, 'description')) ?? name;
        const values = field(property, 'enum');
        const options = Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string').map(label => ({ label }) as Obj) : null;
        out.push(question(name, header, asked, options, field(property, 'type') === 'array', hidden));
      }
    }
    return { questions: out, secret, structured: false };
  }
  if (kind === 'url') {
    const asked = [nonEmpty(field(data, 'message')), nonEmpty(field(data, 'url'))].filter((part): part is string => part !== null).join('\n');
    return { questions: [question('url', null, asked, null, false, false)], secret, structured: false };
  }
  return { questions: [question('q0', null, text.trim() === '' ? 'The agent asks a question.' : text, null, false, false)], secret, structured: false };
}

/** `PendingQuestion`. */
export function pendingQuestion(request: Request, facts: Facts): { payload: Obj; secret: Set<string>; structured: boolean } {
  const { questions, secret, structured } = questionsOf(request.text, request.data);
  return { payload: { requestId: request.request, taskId: request.task, projectId: facts.project, harness: facts.harness, questions, at: request.at }, secret, structured };
}

// ---- The book ----------------------------------------------------------------------------------------------------------

interface Entry { kind: Kind; task: string; request: string; facts: Facts; payload: Obj; secret: Set<string>; structured: boolean; attributed: [string, string | null] | null; order: number }
const keyOf = (task: string, request: string) => JSON.stringify([task, request]);

export class PendingBook {
  private open = new Map<string, Entry>();
  private closed = new Map<string, { task: string; order: number }>();
  private asked = new Map<string, string>();
  private serial = 0;
  revision = 0;

  private next(): number { this.serial += 1; return this.serial; }
  private tombstone(task: string, request: string): void {
    this.closed.set(keyOf(task, request), { task, order: this.next() });
    const oldest = (filter: (task: string) => boolean): string | null => {
      let found: [string, number] | null = null;
      for (const [key, value] of this.closed) if (filter(value.task) && (found === null || value.order < found[1])) found = [key, value.order];
      return found?.[0] ?? null;
    };
    while ([...this.closed.values()].filter(value => value.task === task).length > CLOSED_PER_TASK) { const key = oldest(owner => owner === task); if (key === null) break; this.closed.delete(key); }
    while (this.closed.size > CLOSED_TOTAL) { const key = oldest(() => true); if (key === null) break; this.closed.delete(key); }
  }
  private bound(task: string): void {
    for (;;) {
      const owned = [...this.open.values()].filter(entry => entry.task === task).length;
      if (owned <= OPEN_PER_TASK && this.open.size <= OPEN_TOTAL) break;
      const scoped = owned > OPEN_PER_TASK;
      let oldest: Entry | null = null;
      for (const entry of this.open.values()) if ((!scoped || entry.task === task) && (oldest === null || entry.order < oldest.order)) oldest = entry;
      if (oldest === null) break;
      this.open.delete(keyOf(oldest.task, oldest.request));
      this.tombstone(oldest.task, oldest.request);
      this.revision += 1;
    }
  }

  /** R0505: a package's `ask` is about to put this request's prompt in front of the user. */
  askedBy(task: string, request: string, packageId: string): void {
    if (this.asked.size >= ASKED_LIMIT) this.asked.clear();
    this.asked.set(keyOf(task, localId(request)), packageId);
  }
  isOpen(task: string, request: string): boolean { return this.open.has(keyOf(task, request)); }

  /** A prompt appeared: its `*.pending` event the first time, nothing for a duplicate, resumed or ended identity. */
  openRequest(kind: Kind, request: Request, facts: Facts): Change | null {
    const key = keyOf(request.task, request.request);
    if (this.open.has(key) || this.closed.has(key)) return null;
    const askedKey = keyOf(request.task, localId(request.request));
    const asked = this.asked.get(askedKey) ?? null;
    this.asked.delete(askedKey);
    let payload: Obj; let secret = new Set<string>(); let structured = false;
    if (kind === 'approval') payload = pendingApproval(request, facts, asked);
    else ({ payload, secret, structured } = pendingQuestion(request, facts));
    const order = this.next();
    this.revision += 1;
    this.open.set(key, { kind, task: request.task, request: request.request, facts: { ...facts }, payload, secret, structured, attributed: null, order });
    this.bound(request.task);
    return { event: pendingEvent(kind), facts: { ...facts }, payload };
  }

  /** R0508: the answer about to be sent comes from `packageId`. `StaleContext` when the request is not open. */
  attribute(task: string, request: string, packageId: string, reason: string | null): string | null {
    const entry = this.open.get(keyOf(task, request));
    if (!entry) return 'StaleContext';
    entry.attributed = [packageId, reason];
    return null;
  }
  unattribute(task: string, request: string): void { const entry = this.open.get(keyOf(task, request)); if (entry) entry.attributed = null; }

  /** The request ended: its `*.resolved` event once; nothing for a request that is not open. */
  end(task: string, request: string, ending: Ending): Change | null {
    const key = keyOf(task, request);
    const entry = this.open.get(key);
    if (!entry) return null;
    this.open.delete(key);
    this.tombstone(task, request);
    this.revision += 1;
    return resolved(entry, ending);
  }
  /** A run ended (`run`: the prefix of its requests' ids; `null`: every run of the task). */
  endRun(task: string, run: string | null): Change[] {
    const prefix = run === null ? null : `${run}:`;
    const ids = [...this.open.values()].filter(entry => entry.task === task && (prefix === null || entry.request.startsWith(prefix))).sort((a, b) => a.order - b.order).map(entry => entry.request);
    return ids.flatMap(id => { const change = this.end(task, id, { kind: 'gone' }); return change ? [change] : []; });
  }
  /** The task was removed: its open requests end `cancelled`, then nothing of it is kept. */
  forgetTask(task: string): Change[] {
    const changes = this.endRun(task, null);
    for (const [key, value] of [...this.closed]) if (value.task === task) this.closed.delete(key);
    for (const key of [...this.asked.keys()]) if ((JSON.parse(key) as [string, string])[0] === task) this.asked.delete(key);
    return changes;
  }
  /** `[approvals, questions]` open in `task`. */
  counts(task: string): [number, number] {
    const entries = [...this.open.values()].filter(entry => entry.task === task);
    return [entries.filter(entry => entry.kind === 'approval').length, entries.filter(entry => entry.kind === 'question').length];
  }
  /** The current open set as `hooks.pending` answers it, in the order the requests opened. */
  snapshot(include: (kind: Kind, facts: Facts) => boolean): Obj {
    const approvals: Obj[] = []; const questions: Obj[] = [];
    let size = 0; let truncated = false;
    const measure = (value: Obj) => byteLength(JSON.stringify(value)) + 1;
    for (const entry of [...this.open.values()].sort((a, b) => a.order - b.order)) {
      if (!include(entry.kind, entry.facts)) continue;
      const item: Obj = { ...entry.payload };
      let bytes = measure(item);
      if (size + bytes > SNAPSHOT_BYTES && 'input' in item) { delete item.input; bytes = measure(item); }
      if (size + bytes > SNAPSHOT_BYTES) { truncated = true; continue; }
      size += bytes;
      (entry.kind === 'approval' ? approvals : questions).push(item);
    }
    return { schemaVersion: SCHEMA_VERSION, revision: this.revision, approvals, questions, truncated };
  }
}

function resolved(entry: Entry, ending: Ending): Change {
  const answeredBy = (): By => entry.attributed ? { package: entry.attributed[0] } : 'user';
  let payload: Obj;
  if (entry.kind === 'approval') {
    let approved = false; let by: By = 'cancelled'; let reason: string | null = null;
    if (ending.kind === 'answered') { approved = ending.approved ?? false; by = answeredBy(); reason = entry.attributed?.[1] ?? null; }
    else if (ending.kind === 'withdrawn') by = ending.currentMode !== null && ending.currentMode !== entry.facts.mode ? 'mode' : 'cancelled';
    payload = { requestId: entry.request, taskId: entry.task, approved, by };
    if (typeof entry.payload.callId === 'string') payload.callId = entry.payload.callId;
    if (reason !== null) payload.reason = reason;
  } else {
    const by: By = ending.kind === 'answered' ? answeredBy() : 'cancelled';
    payload = { requestId: entry.request, taskId: entry.task, by };
    const answers = ending.kind === 'answered' && entry.structured ? field(ending.response, 'answers') : undefined;
    if (object(answers)) payload.answers = Object.fromEntries(Object.entries(answers).filter(([id]) => !entry.secret.has(id)));
  }
  return { event: resolvedEvent(entry.kind), facts: entry.facts, payload };
}

/** What a package's attached hooks of one family accept: its `match` and its observe grant for the project. */
export interface Reach { match: Match; granted: (project: string) => boolean }
/**
 * `hooks.pending` of a package: approvals when it attached `approval.pending` or `approval.resolved`, questions when
 * it attached `question.pending` or `question.resolved` (`UnknownReference` with neither), each request only where
 * that hook's `match` accepts its run and the package holds `harness.hooks.observe` for its project.
 */
export function snapshotFor(book: PendingBook, approvals: readonly Reach[], questions: readonly Reach[]): Obj | 'UnknownReference' {
  if (!approvals.length && !questions.length) return 'UnknownReference';
  const reaches = (list: readonly Reach[], facts: Facts) => list.some(reach =>
    matches(reach.match, { event: 'approval.pending', project: facts.project, harness: facts.harness, run: facts.run, toolKind: null, paths: [], payload: {} } as Occurrence) && reach.granted(facts.project));
  return book.snapshot((kind, facts) => reaches(kind === 'approval' ? approvals : questions, facts));
}

// ---- The shared script -------------------------------------------------------------------------------------------------

/** Replays one scenario of scenarios.json on a fresh book: the events, snapshots (without `revision`) and results. */
export function replay(tasks: Obj, at: string, steps: readonly Obj[]): { events: Obj[]; snapshots: Obj[]; results: Json[] } {
  const book = new PendingBook();
  const modes = new Map<string, string>();
  const events: Obj[] = []; const snapshots: Obj[] = []; const results: Json[] = [];
  const factsOf = (task: string): Facts => {
    const row = tasks[task] as Obj;
    return { project: row.project as string, harness: row.harness as string, mode: modes.get(task) ?? (row.mode as string), run: row.run as string };
  };
  const push = (change: Change | null) => { if (change) events.push(changeJson(change)); };
  for (const step of steps) {
    const task = (step.task as string) ?? '';
    const request = (step.request as string) ?? '';
    switch (step.op) {
      case 'event': {
        const [kind, opens] = ofEvent(step.kind as string)!;
        if (opens) {
          push(book.openRequest(kind, {
            task, request, text: (step.text as string) ?? '', data: step.data ?? null, call: typeof step.call === 'string' ? step.call : null,
            input: 'input' in step ? step.input : undefined, askAtHost: step.askAtHost === true, at: typeof step.at === 'string' ? step.at : at,
          }, factsOf(task)));
        } else push(book.end(task, request, { kind: 'withdrawn', currentMode: kind === 'approval' ? factsOf(task).mode : null }));
        break;
      }
      case 'mode': modes.set(task, step.mode as string); break;
      case 'askedBy': book.askedBy(task, request, step.package as string); break;
      case 'attribute': results.push(book.attribute(task, request, step.package as string, typeof step.reason === 'string' ? step.reason : null)); break;
      case 'answered': push(book.end(task, request, { kind: 'answered', approved: typeof step.approved === 'boolean' ? step.approved : null, response: step.response })); break;
      case 'runEnded': book.endRun(task, typeof step.run === 'string' ? step.run : null).forEach(push); break;
      case 'taskRemoved': book.forgetTask(task).forEach(push); break;
      case 'counts': results.push(book.counts(task)); break;
      case 'snapshot': {
        const projects = Array.isArray(step.projects) ? new Set(step.projects as string[]) : null;
        const snapshot = book.snapshot((_, facts) => projects === null || projects.has(facts.project));
        delete snapshot.revision;
        snapshots.push(snapshot);
        break;
      }
      default: throw new Error(`unknown op ${String(step.op)}`);
    }
  }
  return { events, snapshots, results };
}
