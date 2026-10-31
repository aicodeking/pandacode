// Pure state transitions for messages and live runs; no React Native imports (tested in node).
import type { AgentEvent, HostActivity, Message, PendingRequest, TaskStatus, ToolActivity } from '../connect/types.ts';
import { decodeTeamRun, teamBusy, waitingOn, type TeamRun } from './team.ts';
import { decodeSubagent, describeTool, parseFields, subagentActive, todosOf, toolKind, traceText, type Subagent, type Todo } from './trace.ts';

const MAX_TEXT = 262_144;
const MAX_ITEMS = 200;
const MAX_SUBAGENTS = 64;
/** A status line that says the model is thinking (no harness forwards the reasoning text itself). */
const THINKING = /\b(think|thinking|reasoning)\b/i;

export type LiveItem =
  | { kind: 'text'; text: string }
  /** startedAt/endedAt: when this phone first saw it run and finish (ms), for its duration. */
  | { kind: 'tool'; tool: ToolActivity; startedAt?: number; endedAt?: number }
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
  /** When the newest event arrived (phone clock) or the host's lastEventAt, whichever is newer. */
  lastEventAt?: number;
  /** When the run started: the host's runStartedAt, else the first event this phone saw. */
  startedAt?: number;
  /** The run's subagents in start order, from `subagent` events and host snapshots. */
  subagents?: Subagent[];
  /** The newest todo/plan update, shown as one checklist that updates in place. */
  todos?: Todo[];
  /** A "Thinking…" status line, until text or a tool follows. */
  thinking?: string;
  /** The main agent's turn ended with this status while team workers or subagents still run:
   * the task stays working (status 'running') until they settle. */
  held?: TaskStatus;
  /** The architect's team while it keeps the task working (`held`). */
  team?: TeamRun;
}

export const idleLive = (): Live => ({ status: 'idle', activity: '', items: [], approvals: [], inputs: [] });

/** Appends a page of messages that continues after the last stored id; skips any overlap. */
export function mergeMessages(existing: readonly Message[], page: readonly Message[]): Message[] {
  const last = existing.length ? existing[existing.length - 1].id : 0;
  const fresh = page.filter(m => m.id > last);
  // A held message the host had cut is replaced by a whole copy of it.
  const whole = new Map(page.filter(m => m.id <= last && !m.cut).map(m => [m.id, m]));
  const base = existing.some(m => m.cut && whole.has(m.id)) ? existing.map(m => (m.cut && whole.get(m.id)) || m) : (existing as Message[]);
  return fresh.length ? [...base, ...fresh] : base;
}

/** Puts an older page before the first stored message; skips any overlap. */
export function prependMessages(existing: readonly Message[], page: readonly Message[]): Message[] {
  const first = existing.length ? existing[0].id : Infinity;
  const older = page.filter(m => m.id < first);
  return older.length ? [...older, ...existing] : (existing as Message[]);
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
 * - subagent: upsert the child's snapshot by id (src/subagents.ts)
 * - status mentioning thinking/reasoning: the collapsed Thinking line
 * - tool TodoWrite/update_plan: the run's checklist
 * Ignored: done (the host sends it just before run.finished; the live view ends only after
 *   client.ts has copied the final messages, as the desktop mirror does), turn_start, turn_complete, turn_changes, session, task_settings, goal*, commands_changed, steer.
 * Any handled event other than cancellations and subagents marks the task running, as on the desktop.
 * Every event, ignored or not, sets lastEventAt (`now`), which the inbox uses to spot a stalled run.
 */
export function applyEvent(live: Live, event: AgentEvent, now = Date.now()): Live {
  return { ...reduce(live, event, now), lastEventAt: now };
}

function reduce(live: Live, event: AgentEvent, now: number): Live {
  switch (event.kind) {
    case 'subagent': {
      const agent = decodeSubagent(event.data);
      if (!agent) return live;
      const next = { ...live, subagents: upsertSubagents(live.subagents, [agent]) };
      // The last subagent a finished turn waited on is done.
      return next.held && !teamBusy(next.team) && !next.subagents.some(subagentActive) ? ended(next, next.held) : next;
    }
    case 'team': {
      const run = decodeTeamRun(event.data);
      return run && (event.data as { teamStatus?: unknown }).teamStatus !== undefined ? withTeamRun(live, run) : live;
    }
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
  // A run starting: a limit from the last one no longer applies. The main agent working again
  // ends any hold for its team (the next run.finished says whether it still runs).
  const running: Live = active(live.status)
    ? { ...live, status: 'running', held: undefined, team: undefined }
    : { ...live, status: 'running', limited: undefined, startedAt: live.startedAt ?? now, held: undefined, team: undefined };
  switch (event.kind) {
    case 'message_start':
      return { ...running, items: cap([...live.items, { kind: 'text', text: '' }]) };
    case 'text': {
      const items = [...live.items];
      const tail = items[items.length - 1];
      if (tail?.kind === 'text') items[items.length - 1] = { kind: 'text', text: (tail.text + event.text).slice(-MAX_TEXT) };
      else items.push({ kind: 'text', text: event.text.slice(-MAX_TEXT) });
      return { ...running, items: cap(items), activity: event.text.trim() ? 'Generating response' : live.activity, thinking: event.text.trim() ? undefined : live.thinking };
    }
    case 'tool': {
      const tool = event.tool;
      if (!tool) return { ...running, items: cap([...live.items, { kind: 'note', text: event.text.slice(0, 8192) }]) };
      const index = live.items.findIndex(i => i.kind === 'tool' && i.tool.id === tool.id);
      const before = index < 0 ? undefined : live.items[index] as Extract<LiveItem, { kind: 'tool' }>;
      const startedAt = before?.startedAt ?? now;
      const item: LiveItem = { kind: 'tool', tool, startedAt, endedAt: tool.status === 'running' ? undefined : before?.endedAt ?? now };
      const items = index < 0 ? [...live.items, item] : live.items.map((x, i) => (i === index ? item : x));
      const todos = toolKind(tool.name) === 'todo' ? todosOf(parseFields(tool.input)) : [];
      return { ...running, items: cap(items), activity: tool.status === 'running' ? traceText(describeTool(tool)).slice(0, 80) : 'Working…', thinking: undefined, todos: todos.length ? todos : live.todos };
    }
    case 'status':
      return { ...running, activity: event.text, thinking: THINKING.test(event.text) ? event.text.slice(0, 200) : running.thinking };
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

/** Subagents by id, the newer snapshot winning, in start order (at most MAX_SUBAGENTS, finished ones dropped first). */
export function upsertSubagents(list: readonly Subagent[] | undefined, fresh: readonly Subagent[]): Subagent[] {
  const byId = new Map((list ?? []).map(a => [a.id, a]));
  for (const a of fresh) {
    const old = byId.get(a.id);
    if (!old || a.updatedAt >= old.updatedAt) byId.set(a.id, a);
  }
  let all = [...byId.values()].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  while (all.length > MAX_SUBAGENTS) {
    const done = all.findIndex(a => a.status !== 'running' && a.status !== 'waiting');
    all = all.filter((_, i) => i !== (done < 0 ? 0 : done));
  }
  return all;
}

/** A host time in ms (a value small enough to be seconds is scaled), or undefined. */
const hostTime = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? (value < 1e11 ? value * 1000 : value) : undefined);

/** Newer hosts' lastEventAt, runStartedAt and subagents on a list row or subscribe reply; older hosts send none. */
export function withHostActivity(live: Live, host: HostActivity | undefined): Live {
  if (!host) return live;
  const lastEventAt = hostTime(host.lastEventAt);
  const startedAt = hostTime(host.runStartedAt);
  // An array (or an `{ items }` envelope).
  const raw: unknown = Array.isArray(host.subagents) ? host.subagents : (host.subagents as { items?: unknown } | undefined)?.items;
  const subagents = Array.isArray(raw) ? raw.slice(0, MAX_SUBAGENTS * 2).map(decodeSubagent).filter((a): a is Subagent => !!a) : [];
  if (lastEventAt === undefined && startedAt === undefined && !subagents.length) return live;
  return {
    ...live,
    lastEventAt: Math.max(live.lastEventAt ?? 0, lastEventAt ?? 0) || undefined,
    startedAt: startedAt ?? live.startedAt,
    subagents: subagents.length ? upsertSubagents(live.subagents, subagents) : live.subagents,
  };
}

/** The row's own `team` (newer hosts, even when null), else `loaded` (from task.team, for older hosts). */
const teamOf = (host: HostActivity | undefined, loaded: TeamRun | undefined) => (host?.team !== undefined ? decodeTeamRun(host.team) : loaded);

/** Active subagents a host row reports (older hosts report none). */
const hostSubagents = (host: HostActivity | undefined) => withHostActivity(idleLive(), host).subagents?.filter(subagentActive) ?? [];

/**
 * A subscribe reply's status and pending requests (when the host sends them) replace the live view's.
 * An ended run keeps only its limit, so the inbox can still say when it resets, unless its team
 * (the row's `team`, else `loaded`) or subagents the host lists as active keep it working.
 */
export function fromSubscribe(live: Live, status: TaskStatus, pending?: readonly PendingRequest[], host?: HostActivity, loaded?: TeamRun): Live {
  const team = teamOf(host, loaded);
  if (status !== 'running' && status !== 'waiting') return ended(live, status, team, hostSubagents(host));
  const valid = pending?.filter(p => typeof p?.requestId === 'string' && p.requestId && typeof p.text === 'string');
  const approvals = valid ? valid.filter(p => p.kind === 'approval') : live.approvals;
  const inputs = valid ? valid.filter(p => p.kind === 'input_request') : live.inputs;
  const next = withHostActivity({ ...live, status: approvals.length + inputs.length ? 'waiting' : status, approvals, inputs }, host);
  // Newer hosts list an architect as running while its team works: show what it waits on.
  return teamBusy(team) && (live.held || !active(live.status)) && !approvals.length && !inputs.length
    ? { ...next, held: live.held ?? 'idle', team, activity: waitingOn(team!.activeWorkers) }
    : next;
}

/**
 * The live view after its run ended with `status`: empty but for the account limit it hit. While
 * its team is busy, or any of `subagents` (by default the live view's own) is still active, the task
 * stays working instead: status 'running', held with the final status, keeping those subagents.
 */
export function ended(live: Live | undefined, status: TaskStatus, team?: TeamRun, subagents: readonly Subagent[] = live?.subagents ?? []): Live {
  const busy = teamBusy(team);
  // The newer snapshot of each one wins (a subagent the phone saw finish stays finished).
  const children = status === 'stopped' ? [] : upsertSubagents(live?.subagents?.filter(a => subagents.some(s => s.id === a.id)), subagents).filter(subagentActive);
  if (!busy && !children.length) return live?.limited ? { ...idleLive(), status, limited: live.limited } : { ...idleLive(), status };
  return {
    ...idleLive(), status: 'running', activity: busy ? waitingOn(team!.activeWorkers) : '', held: status, team: busy ? team : undefined,
    subagents: children, todos: live?.todos, limited: live?.limited, startedAt: live?.startedAt, lastEventAt: live?.lastEventAt,
  };
}

/** A team update for a task: a busy team updates what a held task waits on; a settled one ends the hold. */
export function withTeamRun(live: Live, run: TeamRun): Live {
  if (!live.held) return live;
  if (teamBusy(run)) return { ...live, team: run, activity: waitingOn(run.activeWorkers) };
  const status = run.status === 'failed' || run.status === 'stopped' ? run.status : live.held;
  return ended({ ...live, team: undefined }, status);
}

const active = (status: TaskStatus) => status === 'running' || status === 'waiting';

/**
 * A fresh tasks.list row against the live view: a run the phone still shows as working that
 * the host lists as ended (it finished while the phone slept or was offline) is settled, and
 * pending requests listed for a task the phone has no live view of are seeded. Otherwise the
 * live view is kept (undefined when there is none), since events are newer than any list.
 * A task held for its team or subagents settles once the list shows neither still working.
 */
export function fromList(live: Live | undefined, status: TaskStatus, pending?: readonly PendingRequest[], host?: HostActivity, loaded?: TeamRun): Live | undefined {
  if (live && active(live.status) && !active(status)) return fromSubscribe(live, status, pending, host, loaded);
  if (!live && (pending?.length || active(status))) {
    const seeded = fromSubscribe(idleLive(), status, pending, host, loaded);
    return pending?.length || seeded.lastEventAt || seeded.startedAt || seeded.subagents?.length || seeded.team ? seeded : undefined;
  }
  if (!live || !active(live.status)) return live;
  const team = teamOf(host, loaded);
  return withHostActivity(live.held && teamBusy(team) ? withTeamRun(live, team!) : live, host);
}

/** Hosts whose task list is missing or older than `maxAgeMs`. */
export const staleLists = (hosts: readonly string[], loadedAt: Readonly<Record<string, number | undefined>>, now: number, maxAgeMs: number) =>
  hosts.filter(id => now - (loadedAt[id] ?? 0) >= maxAgeMs);
