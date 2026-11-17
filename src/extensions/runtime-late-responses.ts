// Webview and preview twin of src-tauri/src/extensions/runtime_late_responses.rs (runtime phase R5, slice R0508):
// `panda.tasks.respond`, answering an approval or a question after the hook budget. The request must be open in the
// task (an issued id that is no longer open is `StaleContext`, one never seen `NotFound`), the package must hold
// `harness.hooks.decide` for its project and tool kind (a question counts as `other`), and an approval stays inside the
// user's mode and sandbox (R0505's `callCan`). One answer is in flight per request: the user's and the package's paths
// claim it first, and the second claimant is refused. The same rules in the same order as the native module; the shared
// script is tests/fixtures/extensions/runtime-late-responses/scenarios.json. It runs no harness.
import { builtinSupport, BARE, HookPayloads, validateAnswer, type Answer, type Json, type Support } from './runtime-hook-payload.ts';
import { callCan, PERMISSION_REQUEST } from './runtime-hook-decisions.ts';
import { changeJson, localId, PendingBook, type Change, type Ending, type Facts, type Kind } from './runtime-pending-requests.ts';

type Obj = { [key: string]: Json };
const isObject = (value: Json | undefined): value is Obj => value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
const utf8 = (text: string) => new TextEncoder().encode(text).length;

export const METHOD = 'tasksRespond';
export const DECIDE = 'harness.hooks.decide';
export const QUESTION_KIND = 'other';
export const ANSWERS_BYTES = 32 * 1024;
const ANSWERS = 64;
const ISSUED_PER_TASK = 256;
const ISSUED_TOTAL = 8_192;
const ID_BYTES = 512;

export interface Refusal { code: string; path: string }
const refusal = (code: string, path = '$'): Refusal => ({ code, path });
export class Refused extends Error { readonly refusal: Refusal; constructor(refusal: Refusal) { super(refusal.code); this.refusal = refusal; } }

// ---- Parsing -----------------------------------------------------------------------------------------------------------

export type Reply = { kind: 'approval'; approved: boolean; reason: string | null } | { kind: 'answers'; answers: Obj };
export interface Respond { task: string; request: string; reply: Reply }

const ident = (value: Json | undefined, path: string): string => {
  if (typeof value !== 'string' || !value || utf8(value) > ID_BYTES || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Refused(refusal('InvalidShape', path));
  return value;
};

/** `{ taskId, requestId, answer }`, strictly. */
export function parseRespond(params: Json): Respond {
  if (!isObject(params) || Object.keys(params).length !== 3 || !['taskId', 'requestId', 'answer'].every(key => key in params)) throw new Refused(refusal('InvalidShape'));
  const task = ident(params.taskId, '$.taskId');
  const request = ident(params.requestId, '$.requestId');
  const answer = params.answer;
  if (!isObject(answer)) throw new Refused(refusal('InvalidShape', '$.answer'));
  if ('approved' in answer) {
    if (Object.keys(answer).some(key => key !== 'approved' && key !== 'reason')) throw new Refused(refusal('InvalidShape', '$.answer'));
    if (typeof answer.approved !== 'boolean') throw new Refused(refusal('InvalidShape', '$.answer.approved'));
    const raw = answer.reason;
    if (raw !== undefined && raw !== null && typeof raw !== 'string') throw new Refused(refusal('InvalidShape', '$.answer.reason'));
    const reason = typeof raw === 'string' ? raw : null;
    try { validateAnswer({ approved: answer.approved, ...(reason !== null ? { reason } : {}) }); } catch (error) {
      throw new Refused(refusal(String((error as Error).message).startsWith('LimitExceeded') ? 'LimitExceeded' : 'InvalidShape', '$.answer.reason'));
    }
    return { task, request, reply: { kind: 'approval', approved: answer.approved, reason } };
  }
  if (Object.keys(answer).length === 1 && 'answers' in answer) {
    const answers = answer.answers;
    if (!isObject(answers)) throw new Refused(refusal('InvalidShape', '$.answer.answers'));
    if (Object.keys(answers).length > ANSWERS || utf8(JSON.stringify(answers)) > ANSWERS_BYTES) throw new Refused(refusal('LimitExceeded', '$.answer.answers'));
    return { task, request, reply: { kind: 'answers', answers } };
  }
  throw new Refused(refusal('InvalidShape', '$.answer'));
}

// ---- Questions -----------------------------------------------------------------------------------------------------------

export type Form = 'questions' | 'fields' | 'url' | 'other';
export function formOf(data: Json): Form {
  const kind = isObject(data) ? data.kind : undefined;
  return kind === 'questions' ? 'questions' : kind === 'form' ? 'fields' : kind === 'url' ? 'url' : 'other';
}

/** The response for the harness, from `answers` and the question's frozen `questions` (see the native `response_for`). */
export function responseFor(form: Form, questions: readonly Json[], answers: Obj): Obj {
  const known = (id: string) => questions.some(question => isObject(question) && question.id === id);
  const unknown = Object.keys(answers).find(id => !known(id));
  if (unknown !== undefined) throw new Refused(refusal('InvalidShape', `$.answer.answers.${unknown}`));
  switch (form) {
    case 'questions': {
      const ids = Object.keys(answers);
      if (ids.length && ids.length !== questions.length) throw new Refused(refusal('InvalidShape', '$.answer.answers'));
      const out: Obj = {};
      for (const id of ids) {
        const value = answers[id];
        const text = typeof value === 'string' ? value : Array.isArray(value) && value.length === 1 && typeof value[0] === 'string' ? value[0] : null;
        if (!text) throw new Refused(refusal('InvalidShape', `$.answer.answers.${id}`));
        out[id] = [text];
      }
      return { answers: out };
    }
    case 'fields': return { action: 'accept', content: answers };
    case 'url': {
      const value = answers.url;
      const action = value === true ? 'accept' : value === false ? 'decline' : typeof value === 'string' && ['accept', 'decline', 'cancel'].includes(value) ? value : null;
      if (action === null) throw new Refused(refusal('InvalidShape', '$.answer.answers.url'));
      return { action };
    }
    default: throw new Refused(refusal('UnsupportedCapability', '$.answer'));
  }
}

// ---- Claims and issued ids ---------------------------------------------------------------------------------------------

export interface Issued { kind: Kind; form: Form; lasting: boolean }
const keyOf = (task: string, request: string) => JSON.stringify([task, request]);

export interface Answering { arm(): void; release(): void }
export class Responses {
  private claims = new Map<string, { ending: Ending; armed: boolean; token: number }>();
  private issuedIds = new Map<string, { order: number; task: string; request: string; issued: Issued }>();
  private serial = 0;

  /** Claims the answer of a request; `null` while another answer to it is in flight. */
  claim(task: string, request: string, ending: Ending): Answering | null {
    const key = keyOf(task, request);
    if (this.claims.has(key)) return null;
    const token = ++this.serial;
    this.claims.set(key, { ending, armed: false, token });
    return {
      arm: () => { const claim = this.claims.get(key); if (claim?.token === token) claim.armed = true; },
      release: () => { if (this.claims.get(key)?.token === token) this.claims.delete(key); },
    };
  }
  issue(task: string, request: string, issued: Issued): void {
    this.issuedIds.set(keyOf(task, request), { order: ++this.serial, task, request, issued });
    const evict = (filter: (task: string) => boolean, limit: number) => {
      for (;;) {
        const owned = [...this.issuedIds.entries()].filter(([, entry]) => filter(entry.task));
        if (owned.length <= limit) return;
        owned.sort(([, a], [, b]) => a.order - b.order);
        this.issuedIds.delete(owned[0][0]);
      }
    };
    evict(owner => owner === task, ISSUED_PER_TASK);
    evict(() => true, ISSUED_TOTAL);
  }
  issued(task: string, request: string): Issued | null { return this.issuedIds.get(keyOf(task, request))?.issued ?? null; }
  known(request: string): boolean { return [...this.issuedIds.values()].some(entry => entry.request === request); }
  /** The answer a reported withdrawal really was, when an armed claim is in flight. */
  withdrawn(task: string, request: string): Ending | null {
    const claim = this.claims.get(keyOf(task, request));
    return claim?.armed ? claim.ending : null;
  }
}

export const approvalEnding = (approved: boolean): Ending => ({ kind: 'answered', approved, response: undefined });
export const questionEnding = (response: Json): Ending => ({ kind: 'answered', approved: null, response });

// ---- Admission ---------------------------------------------------------------------------------------------------------

export interface Open { kind: Kind; project: string; harness: string; mode: string; tool: string; toolKind: string; questions: Json[] }
export function openOf(kind: Kind, item: Obj): Open {
  const text = (key: string) => typeof item[key] === 'string' ? item[key] as string : '';
  const tool = isObject(item.tool) ? item.tool : {};
  return {
    kind, project: text('projectId'), harness: text('harness'), mode: text('mode'),
    tool: typeof tool.name === 'string' ? tool.name : 'tool',
    toolKind: kind === 'approval' ? (typeof tool.kind === 'string' ? tool.kind : 'other') : QUESTION_KIND,
    questions: Array.isArray(item.questions) ? item.questions : [],
  };
}

export interface World {
  open(task: string, request: string): Open | null;
  issued(task: string, request: string): Issued | null;
  known(request: string): boolean;
  holdsAny(): boolean;
  granted(project: string, toolKind: string): boolean;
  mode(task: string): string | null;
  support(task: string, request: string): Support;
}
export type Plan = { kind: 'approval'; approved: boolean; reason: string | null; support: Support } | { kind: 'question'; response: Obj };
export const planEnding = (plan: Plan): Ending => plan.kind === 'approval' ? approvalEnding(plan.approved) : questionEnding(plan.response);

function inferForm(questions: readonly Json[]): Form {
  const ids = questions.map(question => isObject(question) ? question.id : null);
  if (ids.length === 1 && ids[0] === 'url') return 'url';
  if (ids.length === 1 && ids[0] === 'q0') return 'other';
  return questions.some(question => isObject(question) && question.multiple === true) ? 'fields' : 'questions';
}

/** Checks a parsed answer against the open request, the grant and the mode; throws `Refused`. */
export function admit(world: World, respond: Respond): { open: Open; plan: Plan } {
  if (!world.holdsAny()) throw new Refused(refusal('PermissionDenied', DECIDE));
  const open = world.open(respond.task, respond.request);
  if (!open) throw new Refused(refusal(world.known(respond.request) ? 'StaleContext' : 'NotFound', '$.requestId'));
  if (!world.granted(open.project, open.toolKind)) throw new Refused(refusal('PermissionDenied', DECIDE));
  const issued = world.issued(respond.task, respond.request);
  if (respond.reply.kind === 'approval' && open.kind === 'approval') {
    const support = world.support(respond.task, respond.request);
    if (respond.reply.approved) {
      const mode = world.mode(respond.task) ?? open.mode;
      if (!callCan(support, PERMISSION_REQUEST, open.harness, mode, open.toolKind, issued?.lasting ?? false).includes('approve')) throw new Refused(refusal('UnsupportedCapability', '$.answer.approved'));
    }
    return { open, plan: { kind: 'approval', approved: respond.reply.approved, reason: respond.reply.reason, support } };
  }
  if (respond.reply.kind === 'answers' && open.kind === 'question') {
    return { open, plan: { kind: 'question', response: responseFor(issued?.form ?? inferForm(open.questions), open.questions, respond.reply.answers) } };
  }
  throw new Refused(refusal('InvalidShape', '$.answer'));
}

// ---- Sending -----------------------------------------------------------------------------------------------------------

/** Under the approvals lock: the grant again, the attribution, the adapter's details; the steering text after a deny. */
export function attributeApproval(book: PendingBook, payloads: HookPayloads, run: string, task: string, request: string, original: string, owner: string, name: string, tool: string, approved: boolean, reason: string | null, grantedNow: boolean): string | null {
  if (!grantedNow) throw new Error('PermissionDenied');
  const attributed = book.attribute(task, request, owner, reason);
  if (attributed) throw new Error(attributed);
  const support = payloads.support(run, original);
  try { payloads.attach(run, original, { approved, ...(reason !== null ? { reason } : {}), decidedBy: owner }); } catch { /* the bare answer still goes */ }
  return support && !approved && support.denyReason === 'steer' && reason !== null ? `${name} denied ${tool}: ${reason}` : null;
}
export function attributeQuestion(book: PendingBook, payloads: HookPayloads, run: string, task: string, request: string, original: string, owner: string, grantedNow: boolean): boolean {
  if (!grantedNow) throw new Error('PermissionDenied');
  const attributed = book.attribute(task, request, owner, null);
  if (attributed) throw new Error(attributed);
  try { payloads.attachQuestion(run, original, owner); return true; } catch { return false; }
}
export function undo(book: PendingBook, payloads: HookPayloads, run: string, task: string, request: string, original: string | null, plan: Plan, questionAttached: boolean): void {
  book.unattribute(task, request);
  if (original === null) return;
  if (plan.kind === 'approval') { try { payloads.attach(run, original, { approved: plan.approved }); } catch { /* not open there: nothing attached */ } }
  else if (questionAttached) payloads.openQuestion(run, original);
}
export function codeOf(error: string): string {
  if (error === 'PermissionDenied' || error === 'StaleContext') return error;
  if (/no longer pending|earlier run|no longer running|has stopped|stopped before/.test(error)) return 'StaleContext';
  if (/^(Answer |Response |Each |A required|Choose )/.test(error)) return 'InvalidShape';
  return 'HostUnavailable';
}
export function line(kind: Kind, tool: string, name: string, approved: boolean, reason: string | null): string {
  const tail = reason !== null ? ` ${reason}` : '';
  return kind === 'approval' ? `${tool} ${approved ? 'approved' : 'denied'} through ${name}.${tail}` : `Question answered through ${name}.`;
}

// ---- The shared script -------------------------------------------------------------------------------------------------

interface Agent { run: string; pending: Set<string>; alive: boolean }
const agentOriginal = (agent: Agent | undefined, request: string): string => {
  if (!agent) throw new Error('This agent is no longer running.');
  if (!agent.alive || !agent.pending.has(request)) throw new Error('This approval is no longer pending.');
  if (!request.startsWith(`${agent.run}:`)) throw new Error('This approval belongs to an earlier run.');
  return request.slice(agent.run.length + 1);
};
const answerJson = (request: string, answer: Answer): Obj => ({ request, approved: answer.approved, ...(answer.reason !== undefined ? { reason: answer.reason } : {}), ...(answer.decidedBy !== undefined ? { decidedBy: answer.decidedBy } : {}) });
const questionJson = (request: string, response: Json, by: string | null): Obj => ({ request, response, ...(by !== null ? { decidedBy: by } : {}) });

/** Replays one scenario of scenarios.json: resolved events, results and what each agent received (native `replay`). */
export function replay(script: Obj, steps: readonly Obj[]): { events: Obj[]; results: Json[]; inputs: Obj[] } {
  const table = script.tasks as Obj;
  const pkg = script.package as Obj;
  const owner = pkg.id as string; const name = pkg.name as string;
  const book = new PendingBook(); const payloads = new HookPayloads(); const responses = new Responses();
  const agents = new Map<string, Agent>(Object.entries(table).map(([task, row]) => [task, { run: (row as Obj).agentRun as string, pending: new Set<string>(), alive: true }]));
  const modes = new Map<string, string>();
  let granted = true; let enabled = true; let held: Answering | null = null;
  const events: Obj[] = []; const results: Json[] = []; const inputs: Obj[] = [];
  const facts = (task: string): Facts => { const row = table[task] as Obj; return { project: row.project as string, harness: row.harness as string, mode: modes.get(task) ?? (row.mode as string), run: 'task' }; };
  const push = (change: Change | null) => { if (change && change.event.endsWith('.resolved')) events.push(changeJson(change)); };
  const worldOpen = (task: string, request: string): Open | null => {
    if (!book.isOpen(task, request)) return null;
    const snapshot = book.snapshot(() => true);
    for (const [list, kind] of [['approvals', 'approval'], ['questions', 'question']] as const) {
      const item = (snapshot[list] as Obj[]).find(entry => entry.taskId === task && entry.requestId === request);
      if (item) return openOf(kind, item);
    }
    return null;
  };
  const world: World = {
    open: worldOpen, issued: (task, request) => responses.issued(task, request), known: request => responses.known(request),
    holdsAny: () => enabled, granted: () => enabled && granted, mode: task => facts(task).mode,
    support: (task, request) => payloads.support(task, localId(request)) ?? BARE,
  };
  const respond = (step: Obj): Json => {
    let parsed: Respond; let admitted: { open: Open; plan: Plan };
    try { parsed = parseRespond({ taskId: step.task ?? null, requestId: step.request ?? null, answer: step.answer ?? null }); admitted = admit(world, parsed); } catch (error) { if (error instanceof Refused) return error.refusal.code; throw error; }
    const { open, plan } = admitted; const { task, request } = parsed;
    const answering = responses.claim(task, request, planEnding(plan));
    if (!answering) return 'StaleContext';
    try {
      let original: string;
      try { original = agentOriginal(agents.get(task), request); } catch (error) { return codeOf((error as Error).message); }
      const grantedNow = enabled && granted && step.revokeAtSend !== true;
      const sent: Obj[] = [];
      try {
        if (plan.kind === 'approval') {
          const steer = attributeApproval(book, payloads, task, task, request, original, owner, name, open.tool, plan.approved, plan.reason, grantedNow);
          answering.arm();
          sent.push(answerJson(original, payloads.take(task, original, plan.approved)));
          if (steer !== null) sent.push({ steer });
        } else {
          const attached = attributeQuestion(book, payloads, task, task, request, original, owner, grantedNow);
          answering.arm();
          if (step.reject === true) { undo(book, payloads, task, task, request, original, plan, attached); return 'InvalidShape'; }
          sent.push(questionJson(original, plan.response, payloads.takeQuestion(task, original)));
        }
      } catch (error) { undo(book, payloads, task, task, request, original, plan, false); return codeOf((error as Error).message); }
      inputs.push(...sent);
      agents.get(task)!.pending.delete(request);
      if (step.withdrawOnSend === true) { const ending = responses.withdrawn(task, request); if (ending) push(book.end(task, request, ending)); }
      push(book.end(task, request, planEnding(plan)));
      return null;
    } finally { answering.release(); }
  };
  const user = (step: Obj): Json => {
    const task = step.task as string; const request = step.request as string;
    const ending = 'response' in step ? questionEnding(step.response ?? null) : approvalEnding(step.approved === true);
    const answering = responses.claim(task, request, ending);
    if (!answering) return 'busy';
    try {
      let original: string;
      try { original = agentOriginal(agents.get(task), request); } catch { return 'stale'; }
      answering.arm();
      inputs.push('response' in step ? questionJson(original, step.response ?? null, payloads.takeQuestion(task, original)) : answerJson(original, payloads.take(task, original, step.approved === true)));
      agents.get(task)!.pending.delete(request);
      push(book.end(task, request, ending));
      return null;
    } finally { answering.release(); }
  };
  for (const step of steps) {
    const task = (step.task as string) ?? '';
    switch (step.op) {
      case 'open': {
        const request = step.request as string; const kind = step.kind as Kind; const data = step.data ?? null;
        if (kind === 'approval') payloads.openApproval(task, localId(request), null, builtinSupport((table[task] as Obj).harness as string));
        else payloads.openQuestion(task, localId(request));
        responses.issue(task, request, { kind, form: formOf(data), lasting: isObject(data) && data.lastingOnly === true });
        book.openRequest(kind, { task, request, text: (step.text as string) ?? '', data, call: null, input: undefined, askAtHost: false, at: '2026-11-17T00:00:00.000Z' }, facts(task));
        agents.get(task)!.pending.add(request);
        break;
      }
      case 'wait': break;
      case 'respond': results.push(respond(step)); break;
      case 'user': results.push(user(step)); break;
      case 'hold': held = responses.claim(task, step.request as string, { kind: 'gone' }); break;
      case 'release': held?.release(); held = null; break;
      case 'withdraw': agents.get(task)!.pending.delete(step.request as string); push(book.end(task, step.request as string, { kind: 'withdrawn', currentMode: facts(task).mode })); break;
      case 'mode': modes.set(task, step.mode as string); break;
      case 'revoke': granted = false; break;
      case 'grant': granted = true; break;
      case 'disable': enabled = false; break;
      case 'enable': enabled = true; break;
      case 'runEnded': { book.endRun(task, (step.run as string) ?? null).forEach(push); const agent = agents.get(task)!; agent.pending.clear(); agent.run = step.next as string; break; }
      case 'taskRemoved': book.forgetTask(task).forEach(push); agents.get(task)!.alive = false; break;
      default: throw new Error(`unknown op ${String(step.op)}`);
    }
  }
  return { events, results, inputs };
}
