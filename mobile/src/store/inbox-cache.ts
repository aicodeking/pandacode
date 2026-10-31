// The inbox as it last was, drawn on the first frame at launch before the socket connects: the
// device list, each host's task list (with its projects) and bots. client.ts saves it
// (debounced, src/connect/inbox-file.ts) and restores it; live data replaces it host by host.
// Restored rows carry `seenAt` so a run that was going isn't shown as live until a list confirms it.
// Pure: tests/inbox-cache.test.ts.
import type { Bot, Device, TaskSummary, TasksList } from '../connect/types.ts';

/** Bump when the shape changes: an older file is ignored. */
export const INBOX_VERSION = 1;
/** Rows kept per host (the inbox shows the newest). */
export const MAX_TASKS = 200;

type Lists = Record<string, TasksList & { loadedAt: number; cachedAt?: number }>;

export interface InboxSnapshot {
  version: number;
  /** The account it belongs to: another account's file is ignored. */
  account: string;
  devices: Device[];
  lists: Record<string, TasksList & { seenAt: number }>;
  bots: Record<string, Bot[]>;
}

/** Drops what only a live view needs (pending requests, subagents) and the cache's own stamp. */
function slim({ pending: _p, subagents: _s, seenAt: _a, ...task }: TaskSummary): TaskSummary {
  return task;
}

export function encodeInbox(account: string, devices: readonly Device[], tasks: Lists, bots: Readonly<Record<string, readonly Bot[]>>): string {
  const lists: InboxSnapshot['lists'] = {};
  for (const [host, list] of Object.entries(tasks)) {
    lists[host] = { tasks: list.tasks.slice(0, MAX_TASKS).map(slim), projects: list.projects, seenAt: list.cachedAt ?? list.loadedAt };
  }
  const snapshot: InboxSnapshot = { version: INBOX_VERSION, account, devices: [...devices], lists, bots: { ...bots } as Record<string, Bot[]> };
  return JSON.stringify(snapshot);
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const validTask = (t: any): t is TaskSummary => record(t) && typeof t.sessionId === 'string' && typeof t.title === 'string' && typeof t.status === 'string' && typeof t.updatedAt === 'number';
const validDevice = (d: any): d is Device => record(d) && typeof d.id === 'string' && typeof d.name === 'string' && typeof d.publicKey === 'string';

export interface RestoredInbox { devices: Device[]; tasks: Lists; bots: Record<string, Bot[]> }

/** The saved inbox for `account`, or null (missing, unreadable, another version or account). Lists
 * come back stale (`loadedAt` 0, so the first presence lists them again) with every row stamped `seenAt`. */
export function decodeInbox(text: string | null, account: string): RestoredInbox | null {
  let value: any;
  try { value = JSON.parse(text ?? 'null'); } catch { return null; }
  if (!record(value) || value.version !== INBOX_VERSION || value.account !== account || !account) return null;
  const tasks: Lists = {};
  for (const [host, list] of Object.entries(record(value.lists) ? value.lists : {})) {
    if (!record(list) || !Array.isArray(list.tasks) || typeof list.seenAt !== 'number') continue;
    const seenAt = list.seenAt;
    tasks[host] = {
      tasks: list.tasks.filter(validTask).map(t => ({ ...t, seenAt })),
      projects: Array.isArray(list.projects) ? list.projects : [],
      loadedAt: 0,
      cachedAt: seenAt,
    };
  }
  const bots: Record<string, Bot[]> = {};
  for (const [host, list] of Object.entries(record(value.bots) ? value.bots : {})) {
    if (Array.isArray(list)) bots[host] = list.filter(b => record(b) && typeof b.id === 'string');
  }
  return { devices: Array.isArray(value.devices) ? value.devices.filter(validDevice) : [], tasks, bots };
}

/** A cached row whose run looked active when last seen: shown as "last seen", never as live. */
export const seenOnly = (task: Pick<TaskSummary, 'seenAt'>) => task.seenAt !== undefined;
