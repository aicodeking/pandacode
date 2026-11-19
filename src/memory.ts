/* Memory Fabric, the composer side: a per-thread switch, and the bounded block an
 * outgoing message carries. The block is appended only when its digest changes
 * (or on a periodic reminder), so a long thread is not re-billed every turn.
 * Everything here fails open: a memory error never blocks a prompt.
 *
 * Notes are reference material and are labelled as such; they are never
 * instructions. Storage is local (SQLite) and off until the user turns it on. */
import { memoryApi } from './memory-api.ts';

const leafIcon = '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M19 3C5 3 2 9 5 15s14 4 14-12ZM5 20l9-11"/></svg>';

const KEY = 'pandacode.memoryFabric';
/** Restate the memory block this many messages after it was last sent. */
export const REMIND_EVERY = 8;

type ThreadMemory = { enabled?: boolean; sentDigest?: string; turns?: number };
type Store = { enabled: boolean; threads: Record<string, ThreadMemory> };

function read(): Store {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (value && typeof value === 'object') {
      return {
        enabled: value.enabled === true,
        threads: value.threads && typeof value.threads === 'object' ? value.threads : {},
      };
    }
  } catch { /* Start fresh. */ }
  return { enabled: false, threads: {} };
}

function write(store: Store): void {
  try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* This session keeps it. */ }
}

/** The setting new threads start from. Off by default. */
export function memoryDefault(): boolean {
  return read().enabled;
}

export function setMemoryDefault(enabled: boolean): void {
  write({ ...read(), enabled });
}

/** A thread's own switch wins; otherwise it follows the default. */
export function memoryEnabled(sessionId?: string): boolean {
  const store = read();
  const own = sessionId ? store.threads[sessionId]?.enabled : undefined;
  return typeof own === 'boolean' ? own : store.enabled;
}

/** Flips one thread without changing the default for new threads. */
export function toggleThreadMemory(sessionId: string): boolean {
  const next = !memoryEnabled(sessionId);
  const store = read();
  write({ ...store, threads: { ...store.threads, [sessionId]: { ...store.threads[sessionId], enabled: next } } });
  return next;
}

export function memoryButtonHtml(sessionId: string): string {
  const on = memoryEnabled(sessionId);
  const hint = on
    ? 'Memory Fabric is on in this thread: shared local notes ride with your next message.'
    : 'Memory Fabric is off: turn it on to carry shared local notes.';
  return `<button type="button" class="icon-button composer-memory" data-action="memory" data-on="${on}" aria-pressed="${on}" title="${hint}" aria-label="Memory Fabric ${on ? 'on' : 'off'}">${leafIcon}</button>`;
}

/**
 * The block to append to an outgoing message, or '' when nothing needs saying.
 * The digest is cached per thread; a changed shelf is sent at once and an
 * unchanged one every REMIND_EVERY messages. Failures return ''.
 */
export async function contextFor(
  sessionId: string,
  projectId: string | null | undefined,
  api: Pick<typeof memoryApi, 'context' | 'touch'> = memoryApi,
): Promise<string> {
  if (!memoryEnabled(sessionId)) return '';
  let result;
  try {
    result = await api.context(projectId, sessionId);
  } catch {
    return '';
  }
  const store = read();
  const thread = store.threads[sessionId] ?? {};
  if (!result.text) {
    if (thread.sentDigest) write({ ...store, threads: { ...store.threads, [sessionId]: { ...thread, sentDigest: '', turns: 0 } } });
    return '';
  }
  const changed = result.digest !== (thread.sentDigest ?? '');
  const turns = (thread.turns ?? 0) + 1;
  const due = changed || turns >= REMIND_EVERY;
  write({
    ...store,
    threads: { ...store.threads, [sessionId]: { ...thread, sentDigest: result.digest, turns: due ? 0 : turns } },
  });
  if (!due) return '';
  try { await api.touch(result.ids); } catch { /* The hit count is optional. */ }
  return `\n\n${result.text}`;
}
