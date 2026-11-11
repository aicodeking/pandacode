// Find in a thread: which transcript rows hold the query, and stepping between them. Searches the
// loaded messages only; the screen asks for older pages when the reader wants more. Pure (tests/find.test.ts).
import type { TurnRow } from './turns.ts';

/** Shorter queries match nearly everything and say nothing. */
export const MIN_QUERY = 2;

/** Case-, accent- and width-insensitive form for matching. */
export const fold = (text: string) => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The words a row shows that find looks through. */
export function rowText(row: TurnRow): string {
  switch (row.kind) {
    case 'user':
    case 'reply':
    case 'note':
      return row.message.content;
    case 'work':
      // Thinking and narration between tools; tool calls themselves are JSON nobody reads.
      return row.steps.filter(m => m.role === 'assistant').map(m => m.content).join('\n');
    default:
      return '';
  }
}

/** Times `needle` (already folded) occurs in `text`. */
function occurrences(text: string, needle: string): number {
  const hay = fold(text);
  let count = 0;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

export interface FindHit { rowId: string; count: number }

/** The rows holding `query`, oldest first, with how often each does. Empty under MIN_QUERY. */
export function findHits(rows: readonly TurnRow[], query: string): FindHit[] {
  const needle = fold(query.trim());
  if (needle.length < MIN_QUERY) return [];
  const hits: FindHit[] = [];
  for (const row of rows) {
    const count = occurrences(rowText(row), needle);
    if (count) hits.push({ rowId: row.id, count });
  }
  return hits;
}

/** The match a new search lands on: the newest, where the reader is. -1 with none. */
export const firstHit = (hits: readonly FindHit[]) => hits.length - 1;

/** Steps to the older (-1) or newer (+1) match, wrapping around. */
export function stepHit(index: number, total: number, direction: -1 | 1): number {
  if (total <= 0) return -1;
  if (index < 0 || index >= total) return direction < 0 ? total - 1 : 0;
  return (index + direction + total) % total;
}

/** After the rows change (an older page arrived, a new message), the same row stays current when it's still a hit. */
export function keepHit(before: string | undefined, hits: readonly FindHit[]): number {
  if (before) {
    const at = hits.findIndex(h => h.rowId === before);
    if (at >= 0) return at;
  }
  return firstHit(hits);
}

/** "3 of 7", counting from the oldest loaded match; "No matches" with none; "" with no query. */
export function hitLabel(index: number, hits: readonly FindHit[], query: string): string {
  if (fold(query.trim()).length < MIN_QUERY) return '';
  if (!hits.length) return 'No matches';
  return `${index + 1} of ${hits.length}`;
}

/** Where a row sits in the list's data, which is reversed when the list is inverted. */
export function listIndex(data: readonly TurnRow[], rowId: string): number {
  return data.findIndex(row => row.id === rowId);
}

/** The row that shows message `id`: its own prompt, reply or note, the work row folding it, or its changes row. */
export function rowOfMessage(rows: readonly TurnRow[], id: number): string | undefined {
  for (const row of rows) {
    switch (row.kind) {
      case 'user':
      case 'reply':
      case 'note':
        if (row.message.id === id) return row.id;
        break;
      case 'work':
        if (row.steps.some(m => m.id === id)) return row.id;
        break;
      case 'changes':
        if (row.messageId === id) return row.id;
        break;
    }
  }
  return undefined;
}

/** How many older pages a jump to a search hit may ask for before it gives up. */
export const JUMP_PAGES = 8;

/** A jump to a message: its row is loaded (`show`), an older page may hold it (`older`), the thread is
 * still copying (`wait`), or it can't be shown (`missing`: not in the thread, or too far back). */
export type JumpStep = { kind: 'show'; rowId: string } | { kind: 'older' } | { kind: 'wait' } | { kind: 'missing' };

export interface JumpState {
  rows: readonly TurnRow[];
  /** The oldest loaded message's id; undefined with none loaded. */
  oldest: number | undefined;
  /** The copy from the host has settled (succeeded or failed). */
  ready: boolean;
  older: 'more' | 'loading' | undefined;
  /** Older pages this jump has asked for so far. */
  pages: number;
}

/** What a jump to `messageId` does next. Pure (tests/find.test.ts). */
export function jumpStep(messageId: number, { rows, oldest, ready, older, pages }: JumpState): JumpStep {
  const rowId = rowOfMessage(rows, messageId);
  if (rowId) return { kind: 'show', rowId };
  if (!ready || older === 'loading') return { kind: 'wait' };
  // Within the loaded range but on no row (an error the failed banner shows, say): nothing older helps.
  if (oldest !== undefined && messageId >= oldest) return { kind: 'missing' };
  if (older === 'more' && pages < JUMP_PAGES) return { kind: 'older' };
  return { kind: 'missing' };
}

/** A route's `message` param as a message id, or undefined when absent or malformed. */
export function messageParam(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !/^\d{1,15}$/.test(raw)) return undefined;
  const id = Number(raw);
  return id > 0 ? id : undefined;
}
