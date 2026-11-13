// The task list's pure model, shared by the client (connect/api/threads.ts, store/local.ts, the
// board) and the demo host (demo/threads.ts): stages, thread names, optimistic task-list edits and
// export paging. Pure, so tests/threads.test.ts covers it in node.
import type { Message, TaskSummary } from '../connect/types.ts';
import type { ConnectState } from './index.ts';

type Tasks = ConnectState['tasks'];

/** The stages thread.setStage takes (the desktop's task board columns). */
export const STAGES = ['pending', 'in_progress', 'review', 'completed'] as const;
export type Stage = (typeof STAGES)[number];
/** The stages' names: the desktop board's own (store/stages.ts). */
export { STAGE_NAMES as STAGE_LABELS } from './stages.ts';
export const isStage = (value: unknown): value is Stage => typeof value === 'string' && (STAGES as readonly string[]).includes(value);

/** thread.goal's reply: the task's details, stage and native goal (Codex), if any. */
export interface ThreadGoal {
  sessionId: string;
  title: string;
  description: string;
  stage: Stage;
  goal: { objective: string; status: string; tokenBudget?: number | null; tokensUsed?: number } | null;
  running: boolean;
}

/** A thread's name as the host accepts it: trimmed, 1–200 characters, one line. */
export const MAX_TITLE = 200;
export function cleanTitle(title: string): string | null {
  const clean = title.replace(/\s+/g, ' ').trim();
  return clean && [...clean].length <= MAX_TITLE ? clean : null;
}

/** The task list with one task changed; the same object when it isn't listed. */
export function patchTask(tasks: Tasks, deviceId: string, sessionId: string, change: Partial<TaskSummary>): Tasks {
  const list = tasks[deviceId];
  if (!list?.tasks.some(t => t.sessionId === sessionId)) return tasks;
  return { ...tasks, [deviceId]: { ...list, tasks: list.tasks.map(t => (t.sessionId === sessionId ? { ...t, ...change } : t)) } };
}

/** The task list without `sessionIds` (deleted, or archived on this phone); the same object when none are listed. */
export function dropTasks(tasks: Tasks, deviceId: string, sessionIds: readonly string[]): Tasks {
  const list = tasks[deviceId];
  const gone = new Set(sessionIds);
  if (!list?.tasks.some(t => gone.has(t.sessionId))) return tasks;
  return { ...tasks, [deviceId]: { ...list, tasks: list.tasks.filter(t => !gone.has(t.sessionId)) } };
}

/** Threads this phone archived (taskKey → when) that are still settled: a prompt after archiving brings one back. */
export function archivedIds(tasks: Tasks, deviceId: string, archived: Readonly<Record<string, number>>): string[] {
  return (tasks[deviceId]?.tasks ?? []).filter(t => {
    const at = archived[`${deviceId}/${t.sessionId}`];
    return at !== undefined && (t.lastPromptAt ?? 0) <= at;
  }).map(t => t.sessionId);
}

/** Every host's list without the threads this phone archived; the same object when there are none. */
export function withoutArchived(tasks: Tasks, archived: Readonly<Record<string, number>>): Tasks {
  let next = tasks;
  for (const deviceId of Object.keys(tasks)) next = dropTasks(next, deviceId, archivedIds(next, deviceId, archived));
  return next;
}

/** Pages of an export joined in order, stopping at `cap` bytes (a share sheet takes text, not files). */
export const EXPORT_CAP = 2 * 1024 * 1024;
/** Ends an export cut short (by EXPORT_CAP here, or by the share cap below). */
export const TRUNCATED_MARK = '\n\n[Truncated]';
/** Android's share sheet sends the text through a ~1 MB binder transaction (UTF-16 in the Intent), so
 * text shared there stays under this many UTF-8 bytes. */
export const ANDROID_SHARE_CAP = 480 * 1024;

export const isTruncatedExport = (text: string): boolean => text.endsWith(TRUNCATED_MARK);

/** Bytes `text` takes as UTF-8. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) { bytes += 4; i += 1; }
    else bytes += 3;
  }
  return bytes;
}

/** `text` within `capBytes` UTF-8 bytes (mark included), cut on a character boundary and marked. */
export function capExport(text: string, capBytes: number): { text: string; truncated: boolean } {
  const truncated = isTruncatedExport(text);
  if (utf8Length(text) <= capBytes) return { text, truncated };
  const body = truncated ? text.slice(0, -TRUNCATED_MARK.length) : text;
  const budget = Math.max(0, capBytes - utf8Length(TRUNCATED_MARK));
  let bytes = 0;
  let end = 0;
  while (end < body.length) {
    const code = body.charCodeAt(end);
    const pair = code >= 0xd800 && code <= 0xdbff && end + 1 < body.length;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3;
    if (bytes + size > budget) break;
    bytes += size;
    end += pair ? 2 : 1;
  }
  return { text: `${body.slice(0, end)}${TRUNCATED_MARK}`, truncated: true };
}

/** A safe file name for an exported thread: the title without path or control characters, `.md`. */
export function exportFileName(title: string): string {
  const base = title.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+/, '').slice(0, 80).trim();
  return `${base || 'Task'}.md`;
}

/** The host's refusal of an expired snapshot token (threads.rs): the export starts again. */
export const EXPORT_EXPIRED = 'This export changed or expired. Export again.';
export const EXPORT_CHANGING = 'This thread kept changing while it exported. Try again when the agent is done.';
/** Fresh starts after the export changed under the paging, before giving up. */
const EXPORT_ATTEMPTS = 3;

export interface ExportPage { text: string; next?: number | null; token?: string; version?: string }
class ExportChanged extends Error {}

/**
 * Reads an export page by page. Page 0 answers a `token` naming the host's snapshot, passed back on
 * every later page so they read the same text, and a `version`; a later page with another version
 * (a host paging without snapshots) or an expired token starts again from 0, up to three times.
 */
export async function readPages(page: (offset: number, token?: string) => Promise<ExportPage>, cap = EXPORT_CAP): Promise<{ text: string; truncated: boolean }> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await readOnce(page, cap);
    } catch (error) {
      if (!(error instanceof ExportChanged)) throw error;
      if (attempt >= EXPORT_ATTEMPTS) throw new Error(EXPORT_CHANGING);
    }
  }
}

async function readOnce(page: (offset: number, token?: string) => Promise<ExportPage>, cap: number): Promise<{ text: string; truncated: boolean }> {
  let text = '';
  let offset = 0;
  let token: string | undefined;
  let version: string | undefined;
  for (;;) {
    let reply: ExportPage;
    try {
      reply = await page(offset, offset > 0 ? token : undefined);
    } catch (error) {
      throw offset > 0 && error instanceof Error && error.message === EXPORT_EXPIRED ? new ExportChanged() : error;
    }
    if (offset === 0) ({ token, version } = reply);
    else if (version && reply.version && reply.version !== version) throw new ExportChanged();
    text += reply.text;
    if (reply.next == null) return { text, truncated: false };
    if (text.length >= cap || reply.next <= offset) return { text: `${text}${TRUNCATED_MARK}`, truncated: true };
    offset = reply.next;
  }
}

/** A short version of the text, as the host's: it changes when the text does. */
export function exportVersion(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

/** The transcript as the desktop's export writes it. */
export function exportMarkdown(title: string, messages: readonly Message[]): string {
  const turns = messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => `## ${m.role}\n\n${m.content}\n\n`);
  return `# ${title}\n\n${turns.join('')}`;
}
