// /btw side threads: a question or errand beside a task that keeps running.
// Everything here is pure so tests/btw.test.mjs can cover it without a DOM.

/** How much main-thread text one side-thread message may carry. */
export const CONTEXT_LIMIT = 24 * 1024;
export const TITLE_PREFIX = 'BTW: ';

export interface BtwLink {
  /** The side thread's session id. */
  sideId: string;
  /** Newest main-thread message id the side thread has been shown. */
  seenId: number;
  /** Side-thread messages up to this id were copied from the main thread (worktree forks) and stay hidden. */
  hiddenThrough?: number;
}
export interface MainMessage { id: number; role: string; content: string }
export interface MainThread { title: string; status: string }

/** `/btw` → `''`, `/btw ask this` → `'ask this'`, anything else → `null`. */
export function parseBtw(text: string): string | null {
  const match = /^\/btw(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? (match[1] ?? '').trim() : null;
}

export function sideTitle(prompt: string): string {
  const line = prompt.replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();
  return TITLE_PREFIX + (line.length > 48 ? line.slice(0, 47) + '…' : line || 'Side thread');
}

const bytes = (value: string) => new TextEncoder().encode(value).length;
const utf8 = (point: number) => point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
/** The end of `value` that fits in `limit` UTF-8 bytes, cut between code points. */
export function tail(value: string, limit: number): string {
  if (bytes(value) <= limit) return value;
  let size = 0, start = value.length;
  while (start > 0) {
    const low = value.charCodeAt(start - 1), pair = start > 1 && low >= 0xdc00 && low <= 0xdfff && value.charCodeAt(start - 2) >= 0xd800 && value.charCodeAt(start - 2) <= 0xdbff;
    const next = pair ? start - 2 : start - 1, point = value.codePointAt(next)!;
    if (size + utf8(point) > limit - 3) break;
    size += utf8(point); start = next;
  }
  return '…' + value.slice(start);
}

/**
 * The folded `Main thread context:` block for the next side-thread message: the main thread's
 * title and status, its user and agent messages newer than `seenId` (newest kept when over
 * `limit`), and its in-progress reply. Returns the new `seenId` with it.
 */
export function mainContext(main: MainThread, messages: MainMessage[], seenId: number, live = '', limit = CONTEXT_LIMIT, gap = false): { text: string; seenId: number } {
  const fresh = messages.filter(m => m.id > seenId && (m.role === 'user' || m.role === 'assistant') && m.content.trim());
  const entries = fresh.map(m => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.content.trim()}`);
  if (live.trim()) entries.push(`Agent (still writing): ${live.trim()}`);
  const kept: string[] = [];
  // `gap`: unseen history older than `messages` was not loaded, so it is reported as left out.
  let budget = limit, truncated = gap;
  for (let index = entries.length - 1; index >= 0; index--) {
    const size = bytes(entries[index]) + 2;
    if (size <= budget) { kept.unshift(entries[index]); budget -= size; continue; }
    if (budget > 256) kept.unshift(tail(entries[index], budget - 2));
    truncated = true; break;
  }
  const first = seenId <= 0;
  const header = [
    `Main thread context: "${main.title}" (${main.status}). You are a side thread opened with /btw beside it; the main thread keeps working on its own, so answer here and leave its work alone unless asked.`,
    kept.length
      ? (first ? 'Recent main-thread messages:' : 'New in the main thread since your last message:')
      : (first ? 'The main thread has no messages yet.' : 'Nothing new in the main thread since your last message.'),
    ...(truncated ? [`Older main-thread text was left out to stay within ${Math.round(limit / 1024)} KB.`] : []),
  ];
  return { text: '\n\n' + [...header, ...kept].join('\n\n'), seenId: Math.max(seenId, ...fresh.map(m => m.id)) };
}

const KEY = 'pandacode.btw';
type Links = Record<string, BtwLink>;
export function readLinks(storage: Pick<Storage, 'getItem'>): Links {
  try {
    const value = JSON.parse(storage.getItem(KEY) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
export function writeLink(storage: Pick<Storage, 'getItem' | 'setItem'>, mainId: string, link: BtwLink | null): void {
  const { [mainId]: _, ...rest } = readLinks(storage);
  storage.setItem(KEY, JSON.stringify(link ? { ...rest, [mainId]: link } : rest));
}
