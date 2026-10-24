// Pure state transitions for messages and live runs; no React Native imports (tested in node).
import type { AgentEvent, Message, PendingRequest, TaskStatus, ToolActivity } from '../connect/types.ts';

const MAX_TEXT = 262_144;
const MAX_ITEMS = 200;

export type LiveItem =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: ToolActivity }
  | { kind: 'note'; text: string }
  | { kind: 'error'; text: string };

/** One task's in-flight run, built from the host's AgentEvents. */
export interface Live {
  status: TaskStatus;
  /** Status line, e.g. "Generating response", "Waiting for approval". */
  activity: string;
  items: LiveItem[];
  approvals: PendingRequest[];
  inputs: PendingRequest[];
  usage?: unknown;
  limited?: { text: string; resetsAt: number | null };
}

export const idleLive = (): Live => ({ status: 'idle', activity: '', items: [], approvals: [], inputs: [] });

/** Appends a page of messages that continues after the last stored id; skips any overlap. */
export function mergeMessages(existing: readonly Message[], page: readonly Message[]): Message[] {
  const last = existing.length ? existing[existing.length - 1].id : 0;
  const fresh = page.filter(m => m.id > last);
  return fresh.length ? [...existing, ...fresh] : (existing as Message[]);
}

export const lastId = (messages: readonly Message[] | undefined) => (messages?.length ? messages[messages.length - 1].id : 0);

const waiting = (live: Live) => live.approvals.length + live.inputs.length > 0;
const cap = (items: LiveItem[]) => (items.length > MAX_ITEMS ? items.slice(-MAX_ITEMS) : items);
const remove = (list: PendingRequest[], id?: string) => list.filter(p => p.requestId !== id);

/**
 * Kinds handled (as src/main.ts does for the desktop):
 * - message_start: a new text segment starts
 * - text: delta appended to the current text segment ("Generating response")
 * - tool: upsert by tool.id ("Running <name>")
 * - status: activity line
 * - error: error item
 * - approval / approval_cancelled, input_request / input_cancelled: pending requests (waiting ↔ running)
 * - usage: context usage data
 * - limited: account limit with resetsAt
 * Ignored: done (the host sends it just before run.finished; the live view ends only after
 *   client.ts has copied the final messages, as the desktop mirror does), turn_start, turn_complete, turn_changes, session, task_settings, goal*, commands_changed, subagent, steer.
 * Any handled event other than cancellations marks the task running, as on the desktop.
 */
export function applyEvent(live: Live, event: AgentEvent): Live {
  switch (event.kind) {
    case 'usage':
      return { ...live, usage: event.data };
    case 'limited': {
      const resetsAt = (event.data as { resetsAt?: number | null } | undefined)?.resetsAt ?? null;
      return { ...live, limited: { text: event.text, resetsAt } };
    }
    case 'approval_cancelled':
    case 'input_cancelled': {
      const next = { ...live, approvals: remove(live.approvals, event.requestId), inputs: remove(live.inputs, event.requestId) };
      return waiting(next) ? next : { ...next, status: live.status === 'idle' ? 'idle' : 'running', activity: live.status === 'waiting' ? 'Continuing task' : live.activity };
    }
  }
  const running = { ...live, status: 'running' as TaskStatus };
  switch (event.kind) {
    case 'message_start':
      return { ...running, items: cap([...live.items, { kind: 'text', text: '' }]) };
    case 'text': {
      const items = [...live.items];
      const tail = items[items.length - 1];
      if (tail?.kind === 'text') items[items.length - 1] = { kind: 'text', text: (tail.text + event.text).slice(-MAX_TEXT) };
      else items.push({ kind: 'text', text: event.text.slice(-MAX_TEXT) });
      return { ...running, items: cap(items), activity: event.text.trim() ? 'Generating response' : live.activity };
    }
    case 'tool': {
      const tool = event.tool;
      if (!tool) return { ...running, items: cap([...live.items, { kind: 'note', text: event.text.slice(0, 8192) }]) };
      const index = live.items.findIndex(i => i.kind === 'tool' && i.tool.id === tool.id);
      const items = index < 0 ? [...live.items, { kind: 'tool' as const, tool }] : live.items.map((item, i) => (i === index ? { kind: 'tool' as const, tool } : item));
      return { ...running, items: cap(items), activity: tool.status === 'running' ? `Running ${tool.name.slice(0, 80)}` : 'Working…' };
    }
    case 'status':
      return { ...running, activity: event.text };
    case 'error':
      return { ...running, items: cap([...live.items, { kind: 'error', text: event.text.slice(0, 8192) }]) };
    case 'approval':
      if (!event.requestId || live.approvals.some(p => p.requestId === event.requestId)) return live;
      return { ...running, status: 'waiting', activity: 'Waiting for approval', approvals: [...live.approvals, { kind: 'approval', requestId: event.requestId, text: event.text, data: event.data, tool: event.tool }] };
    case 'input_request':
      if (!event.requestId || live.inputs.some(p => p.requestId === event.requestId)) return live;
      return { ...running, status: 'waiting', activity: 'Waiting for your answer', inputs: [...live.inputs, { kind: 'input_request', requestId: event.requestId, text: event.text, data: event.data }] };
    default:
      return live;
  }
}

/** A subscribe reply's status and pending requests (when the host sends them) replace the live view's. */
export function fromSubscribe(live: Live, status: TaskStatus, pending?: readonly PendingRequest[]): Live {
  if (status !== 'running' && status !== 'waiting') return { ...idleLive(), status };
  const valid = pending?.filter(p => typeof p?.requestId === 'string' && p.requestId && typeof p.text === 'string');
  const approvals = valid ? valid.filter(p => p.kind === 'approval') : live.approvals;
  const inputs = valid ? valid.filter(p => p.kind === 'input_request') : live.inputs;
  return { ...live, status: approvals.length + inputs.length ? 'waiting' : status, approvals, inputs };
}

const active = (status: TaskStatus) => status === 'running' || status === 'waiting';

/**
 * A fresh tasks.list row against the live view: a run the phone still shows as working that
 * the host lists as ended (it finished while the phone slept or was offline) is settled, and
 * pending requests listed for a task the phone has no live view of are seeded. Otherwise the
 * live view is kept (undefined when there is none), since events are newer than any list.
 */
export function fromList(live: Live | undefined, status: TaskStatus, pending?: readonly PendingRequest[]): Live | undefined {
  if (live && active(live.status) && !active(status)) return fromSubscribe(live, status, pending);
  if (!live && pending?.length) return fromSubscribe(idleLive(), status, pending);
  return live;
}

/** Hosts whose task list is missing or older than `maxAgeMs`. */
export const staleLists = (hosts: readonly string[], loadedAt: Readonly<Record<string, number | undefined>>, now: number, maxAgeMs: number) =>
  hosts.filter(id => now - (loadedAt[id] ?? 0) >= maxAgeMs);
