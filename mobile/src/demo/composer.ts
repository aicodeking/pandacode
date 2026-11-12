// Demo answers for the `composer` feature group (src/connect/api/composer.ts): a slash catalog,
// /btw side threads, a queue on the running CI task and usage for two harnesses. See ./index.ts.
// demo-host.ts imports this module through ./index.ts: `sent` is only used inside a handler body.
import { sent } from '../demo-host.ts';
import type { QueuedEntry, SlashCommand } from '../store/slash.ts';
import type { DemoHandlers } from './index.ts';

const HOUR = 3_600_000;

const cmd = (name: string, description: string, extra: Partial<SlashCommand> = {}): SlashCommand =>
  ({ name, description, argumentHint: null, kind: 'native', source: 'Claude Code', reason: null, action: null, available: true, ...extra });
const app = (name: string, description: string, action: string, argumentHint: string | null = null): SlashCommand =>
  cmd(name, description, { kind: 'action', source: 'PandaCode', action, argumentHint });

export const DEMO_COMMANDS: SlashCommand[] = [
  app('/btw', 'Ask on the side while this task keeps working', 'btw', '<question>'),
  cmd('/compact', 'Clear history but keep a summary in context', { argumentHint: '[instructions]' }),
  app('/diff', 'Show this task’s changes', 'diff'),
  app('/init', 'Create or update AGENTS.md for this repository', 'init'),
  app('/model', 'Choose the model', 'model'),
  app('/new', 'Start a new task', 'new'),
  app('/permissions', 'Choose how the agent asks before acting', 'permissions'),
  app('/recap', 'Summarize this conversation', 'recap'),
  cmd('/review', 'Review the current changes', { argumentHint: '[focus]' }),
  cmd('/security-review', 'Complete a security review of the pending changes', { kind: 'skill', source: 'Project skill' }),
  app('/status', 'Show the harness, model and context', 'status'),
  app('/usage', 'Show usage limits', 'usage'),
  app('/console', 'Open this harness in an interactive console', 'console', '[command]'),
  cmd('/vim', 'Toggle Vim editing mode', { available: false, reason: 'This command is available only in the harness’s terminal interface.' }),
];

const INSTRUCTIONS: Record<string, string> = {
  init: 'Inspect this repository and create or update AGENTS.md with concise, accurate project instructions.',
  recap: 'Summarize this conversation concisely: objective, changes, important decisions, validation, and remaining work.',
};

/** Demo queues by `device/session`; the CI task starts with two waiting messages. */
const queues = new Map<string, QueuedEntry[]>();
const queueOf = (deviceId: string, sessionId: string): QueuedEntry[] => {
  const key = `${deviceId}/${sessionId}`;
  if (!queues.has(key)) {
    const now = Date.now();
    queues.set(key, sessionId === 'flaky' ? [
      { id: 'q1', position: 0, text: 'Once the test passes, run the whole upload suite ten times to be sure.', truncated: false, attachments: 0, createdAt: now - 4 * 60_000, updatedAt: now - 4 * 60_000 },
      { id: 'q2', position: 1, text: 'Then open a pull request against main.', truncated: false, attachments: 1, createdAt: now - 2 * 60_000, updatedAt: now - 2 * 60_000 },
    ] : []);
  }
  return queues.get(key)!;
};
const setQueue = (deviceId: string, sessionId: string, entries: QueuedEntry[]) => {
  const next = entries.map((entry, position) => ({ ...entry, position }));
  queues.set(`${deviceId}/${sessionId}`, next);
  return { entries: next };
};

/** How long, and how many per task, the demo holds removals for `queue.restore` (as composer.rs does). */
export const DEMO_HOLD_MS = 60_000;
const DEMO_HOLD_PER_TASK = 8;
const GONE = 'This queued message was already sent or removed.';
const CANNOT_RESTORE = 'This message can no longer be put back.';
/** `deliveries`: the task's queue delivery count at the removal (and at a restore); a higher
 * count means the queue delivered since, and the entry can't be put back (composer.rs
 * `restore_held`). A prompt sent straight to the task does not count. */
interface Held { readonly entry: QueuedEntry; readonly index: number; readonly at: number; readonly deliveries: number; readonly restored: boolean }
/** Removed entries by `device/session`, newest last. */
const holding = new Map<string, Held[]>();
let queuedCount = 0;
/** Queue deliveries by `device/session` (message_queue.rs `deliveries`); replaced, never mutated. */
let deliveryCounts: ReadonlyMap<string, number> = new Map();
const deliveriesOf = (deviceId: string, sessionId: string): number => deliveryCounts.get(`${deviceId}/${sessionId}`) ?? 0;

/** A demo task.send behind a running turn: the message waits in the task's queue, as on the host. */
export function queueDemoMessage(deviceId: string, sessionId: string, text: string, now: number): QueuedEntry {
  const entry: QueuedEntry = { id: `dq-${(queuedCount += 1)}`, position: 0, text, truncated: false, attachments: 0, createdAt: now, updatedAt: now };
  setQueue(deviceId, sessionId, [...queueOf(deviceId, sessionId), entry]);
  return entry;
}

/** Takes the task's next queued message for delivery and counts the delivery (null when empty). */
export function takeQueuedDemoMessage(deviceId: string, sessionId: string): QueuedEntry | null {
  const [next, ...rest] = queueOf(deviceId, sessionId);
  if (!next) return null;
  setQueue(deviceId, sessionId, rest);
  const key = `${deviceId}/${sessionId}`;
  deliveryCounts = new Map([...deliveryCounts, [key, deliveriesOf(deviceId, sessionId) + 1]]);
  return next;
}

function hold(deviceId: string, sessionId: string, held: Held) {
  const key = `${deviceId}/${sessionId}`;
  const kept = (holding.get(key) ?? []).filter(other => other.entry.id !== held.entry.id && held.at - other.at < DEMO_HOLD_MS);
  holding.set(key, [...kept, held].slice(-DEMO_HOLD_PER_TASK));
}

/** Marks a held entry restored at the current delivery count without changing the held object
 * (holdings are replaced, never mutated), so an entry restored and then delivered can't come back. */
function markRestored(deviceId: string, sessionId: string, id: string) {
  const key = `${deviceId}/${sessionId}`;
  const deliveries = deliveriesOf(deviceId, sessionId);
  holding.set(key, (holding.get(key) ?? []).map(h => (h.entry.id === id ? { ...h, restored: true, deliveries } : h)));
}

const iso = (ms: number) => new Date(ms).toISOString();

export const handlers: DemoHandlers = {
  'slash.list': () => ({ commands: DEMO_COMMANDS, warnings: [] }),
  'slash.resolve': (_ctx, p) => {
    const text = String(p?.text ?? '').trim();
    const [name, ...rest] = text.split(/\s+/);
    const args = rest.join(' ');
    const found = DEMO_COMMANDS.find(c => c.name === name);
    if (found && !found.available) throw new Error(found.reason ?? 'Not available.');
    const action = found?.action ?? null;
    const send = !action ? text : INSTRUCTIONS[action] ? INSTRUCTIONS[action] + (args ? `\n${args}` : '') : null;
    return { action, arguments: args, acceptsAttachments: !action, send };
  },
  'btw.ask': ({ host, deviceId, reply }, p) => {
    const main = host.get().tasks[deviceId]?.tasks.find(t => t.sessionId === p.sessionId);
    if (!main) throw new Error('Task not found.');
    const question = String(p.text ?? '').trim();
    const existing = typeof p.sideId === 'string' && host.get().tasks[deviceId]?.tasks.some(t => t.sessionId === p.sideId) ? p.sideId as string : null;
    const sideId = existing ?? `btw-${host.now()}`;
    const title = existing ? host.get().tasks[deviceId]!.tasks.find(t => t.sessionId === sideId)!.title : `BTW: ${question.length > 48 ? `${question.slice(0, 47)}…` : question}`;
    if (!existing) {
      host.set(s => {
        const list = s.tasks[deviceId]!;
        return { tasks: { ...s.tasks, [deviceId]: { ...list, tasks: [{ ...main, sessionId: sideId, title, status: 'idle', pinned: false, team: undefined }, ...list.tasks] } } };
      });
    }
    host.set(s => sent(s, deviceId, sideId, question, host.now()));
    reply(sideId);
    return { sideId, title, seenId: 0, created: !existing };
  },
  'queue.list': ({ deviceId }, p) => ({ entries: queueOf(deviceId, p.sessionId) }),
  'queue.update': ({ deviceId, host }, p) => {
    const entries = queueOf(deviceId, p.sessionId);
    if (!entries.some(e => e.id === p.id)) throw new Error('This queued message was already sent or removed.');
    return setQueue(deviceId, p.sessionId, entries.map(e => (e.id === p.id ? { ...e, text: String(p.text), updatedAt: host.now() } : e)));
  },
  'queue.remove': ({ deviceId, host }, p) => {
    const entries = queueOf(deviceId, p.sessionId);
    const index = entries.findIndex(e => e.id === p.id);
    if (index < 0) {
      // A retry after a lost reply: an entry already removed and still held (not put back since)
      // answers with the queue again, as composer.rs `remove_queued` does.
      const held = (holding.get(`${deviceId}/${p.sessionId}`) ?? []).find(h => h.entry.id === p.id && host.now() - h.at < DEMO_HOLD_MS);
      if (held && !held.restored) return { entries };
      throw new Error(GONE);
    }
    hold(deviceId, p.sessionId, { entry: entries[index], index, at: host.now(), deliveries: deliveriesOf(deviceId, p.sessionId), restored: false });
    return setQueue(deviceId, p.sessionId, entries.filter(e => e.id !== p.id));
  },
  'queue.restore': ({ deviceId, host }, p) => {
    const entries = queueOf(deviceId, p.sessionId);
    if (entries.some(e => e.id === p.id)) return { entries };
    const held = (holding.get(`${deviceId}/${p.sessionId}`) ?? []).find(h => h.entry.id === p.id && host.now() - h.at < DEMO_HOLD_MS);
    if (!held) throw new Error(CANNOT_RESTORE);
    // Delivery first, as on the host: a restored entry that was then sent can't come back.
    if (deliveriesOf(deviceId, p.sessionId) !== held.deliveries) throw new Error(CANNOT_RESTORE);
    // Restored once and gone again since (sent or removed): as on the host, it can't come back twice.
    if (held.restored) throw new Error(CANNOT_RESTORE);
    markRestored(deviceId, p.sessionId, held.entry.id);
    const at = Math.min(held.index, entries.length);
    return setQueue(deviceId, p.sessionId, [...entries.slice(0, at), held.entry, ...entries.slice(at)]);
  },
  'queue.reorder': ({ deviceId }, p) => {
    const entries = queueOf(deviceId, p.sessionId);
    const ids: string[] = Array.isArray(p.ids) ? p.ids : [];
    if (ids.length !== entries.length || !entries.every(e => ids.includes(e.id))) throw new Error('The queue changed. Try reordering again.');
    return setQueue(deviceId, p.sessionId, ids.map(id => entries.find(e => e.id === id)!));
  },
  'usage.get': ({ host }, p) => {
    const now = host.now();
    const limited = p?.sessionId === 'limit';
    return {
      providers: [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }],
      ledger: {
        scannedAt: now,
        day: { claude: { input: 182_400, cacheRead: 4_210_000, cacheWrite: 310_500, output: 96_300, cost: 6.42 }, codex: { input: 92_000, cacheRead: 1_020_000, cacheWrite: 0, output: 41_800, cost: 1.87 } },
        week: { claude: { input: 1_204_000, cacheRead: 30_800_000, cacheWrite: 2_100_000, output: 640_000, cost: 48.3 }, codex: { input: 520_000, cacheRead: 7_400_000, cacheWrite: 0, output: 260_000, cost: 11.2 } },
      },
      task: p?.sessionId ? {
        sessionId: p.sessionId, provider: 'claude', limitedAt: limited ? now - 13 * 60_000 : null, limitedUntil: limited ? now + 47 * 60_000 : null, resumeAtReset: false,
        tokens: { input: 48_200, cacheRead: 1_320_000, cacheWrite: 88_000, output: 21_400, firstUsed: now - 3 * HOUR, lastUsed: now - 60_000 },
      } : null,
    };
  },
  'usage.limits': ({ host }, p) => {
    const now = host.now();
    if (p.provider === 'codex') {
      return { provider: 'codex', status: 'ok', plan: 'Pro', checkedAt: now, stale: false, windows: [
        { label: '5-hour limit', usedPercent: 38, resetsAt: iso(now + 3.2 * HOUR) },
        { label: 'Weekly limit', usedPercent: 61, resetsAt: iso(now + 4 * 24 * HOUR) },
      ] };
    }
    return { provider: p.provider, status: 'ok', plan: 'Max', checkedAt: now, stale: false, windows: [
      { label: 'Current session', usedPercent: 92, resetsAt: iso(now + 47 * 60_000) },
      { label: 'Weekly · all models', usedPercent: 44, resetsAt: iso(now + 2.5 * 24 * HOUR) },
      { label: 'Weekly · Opus', usedPercent: 73, resetsAt: iso(now + 2.5 * 24 * HOUR), detail: 'Opus only' },
    ] };
  },
  'usage.resumeAtReset': (_ctx, p) => ({ resumeAtReset: !!p.on, limitedUntil: null }),
  'usage.clearLimit': ({ host, deviceId }, p) => {
    host.set(s => {
      const key = `${deviceId}/${p.sessionId}`;
      const live = s.live[key];
      return live ? { live: { ...s.live, [key]: { ...live, limited: undefined } } } : {};
    });
    return {};
  },
};
