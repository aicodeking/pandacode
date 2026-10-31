// The outbox: messages that could not reach their computer (offline, or the phone off the
// relay) wait here, persisted, and are sent in order once the computer answers again.
// Pure (tested in node); src/store/local.ts holds and persists the list.
import { NOT_CONNECTED, OFFLINE } from '../connect/rpc.ts';
import type { OutboxEntry } from './inbox.ts';

export type { OutboxEntry };

/**
 * Errors where the message surely never reached the host: refused before sending, or
 * undeliverable at the relay. A lost connection after sending is not one of them (the host
 * may have it), so it is reported instead of resent.
 */
export const isUnsent = (error: unknown) => error instanceof Error && (error.message === OFFLINE || error.message === NOT_CONNECTED);

export interface FlushDeps {
  online: (deviceId: string) => boolean;
  send: (entry: OutboxEntry) => Promise<unknown>;
}

export interface FlushResult { sent: string[]; failed: Record<string, string> }

/**
 * Sends entries oldest first. Per computer, an offline error stops that computer's queue;
 * any other error marks the entry and holds the rest of its task so order is kept.
 * Entries already marked with an error wait for a manual retry (and hold their task).
 */
export async function flush(entries: readonly OutboxEntry[], deps: FlushDeps): Promise<FlushResult> {
  const result: FlushResult = { sent: [], failed: {} };
  const stoppedHosts = new Set<string>();
  const heldTasks = new Set<string>();
  for (const entry of [...entries].sort((a, b) => a.createdAt - b.createdAt)) {
    const task = `${entry.deviceId}/${entry.sessionId}`;
    if (entry.error) heldTasks.add(task);
    if (heldTasks.has(task) || stoppedHosts.has(entry.deviceId) || !deps.online(entry.deviceId)) continue;
    try {
      await deps.send(entry);
      result.sent.push(entry.id);
    } catch (error) {
      if (isUnsent(error)) stoppedHosts.add(entry.deviceId);
      else {
        result.failed[entry.id] = error instanceof Error ? error.message : 'Could not send.';
        heldTasks.add(task);
      }
    }
  }
  return result;
}

/** The list after a flush: sent entries leave, failed ones carry their error. */
export const applyFlush = (entries: readonly OutboxEntry[], { sent, failed }: FlushResult): OutboxEntry[] =>
  entries.filter(e => !sent.includes(e.id)).map(e => (failed[e.id] ? { ...e, error: failed[e.id] } : e));

/** Validates a stored outbox (SecureStore content is untrusted input). */
export function parseOutbox(raw: string | null): OutboxEntry[] {
  try {
    const value = JSON.parse(raw ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((e): e is OutboxEntry =>
      e && typeof e.id === 'string' && typeof e.deviceId === 'string' && typeof e.sessionId === 'string' && typeof e.text === 'string' && typeof e.createdAt === 'number');
  } catch {
    return [];
  }
}
