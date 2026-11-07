// Groups stored messages into transcript rows: a user prompt, then the turn's work (tools and
// interim notes, folded behind "Worked for 2m"), then the reply. Pure (tested in node).
import type { Message } from '../connect/types.ts';

export type TurnRow =
  | { kind: 'user'; id: string; message: Message }
  | { kind: 'work'; id: string; steps: Message[]; durationMs: number | null; at?: number }
  | { kind: 'reply'; id: string; message: Message }
  | { kind: 'changes'; id: string; files: number; additions: number; deletions: number }
  | { kind: 'note'; id: string; message: Message };

/** Errors and PandaCode's own lines (`system`) stay visible outside the fold. */
const isNote = (m: Message) => m.role === 'error' || m.role === 'system';

/** A message's `turnChanges`, as the desktop's turn footer reads it: only changes attributed to this turn, and only if there are any. Older hosts send none. */
export function changesOf(message: Message): { files: number; additions: number; deletions: number } | null {
  const raw = message.turnChanges as { attributed?: unknown; files?: unknown; additions?: unknown; deletions?: unknown } | null | undefined;
  if (!raw || raw.attributed !== true || !Array.isArray(raw.files) || !raw.files.length) return null;
  return { files: raw.files.length, additions: Number(raw.additions) || 0, deletions: Number(raw.deletions) || 0 };
}

export function turnRows(messages: readonly Message[]): TurnRow[] {
  const rows: TurnRow[] = [];
  let turn: Message[] = [];
  const close = () => {
    if (!turn.length) return;
    const replyIndex = turn.findLastIndex(m => m.role === 'assistant');
    const reply = replyIndex >= 0 ? turn[replyIndex] : undefined;
    const steps = turn.filter((m, i) => i !== replyIndex && !isNote(m));
    const durationMs = turn.reduce<number | null>((max, m) => (m.turnDurationMs != null && m.turnDurationMs > (max ?? -1) ? m.turnDurationMs : max), null);
    if (steps.length || durationMs != null) rows.push({ kind: 'work', id: `w${turn[0].id}`, steps, durationMs, at: reply?.createdAt ?? turn.at(-1)?.createdAt });
    // Notes stay visible after the work, and after a reply that came before them.
    for (const m of turn) if (isNote(m) && (!reply || m.id < reply.id)) rows.push({ kind: 'note', id: `n${m.id}`, message: m });
    if (reply) rows.push({ kind: 'reply', id: `r${reply.id}`, message: reply });
    const changed = turn.findLast(m => changesOf(m));
    const changes = changed && changesOf(changed);
    if (changed && changes) rows.push({ kind: 'changes', id: `c${changed.id}`, ...changes });
    for (const m of turn) if (isNote(m) && reply && m.id > reply.id) rows.push({ kind: 'note', id: `n${m.id}`, message: m });
    turn = [];
  };
  for (const m of messages) {
    if (m.role === 'user') {
      close();
      rows.push({ kind: 'user', id: `u${m.id}`, message: m });
    } else turn.push(m);
  }
  close();
  return rows;
}

const sameMessage = (a: Message, b: Message) => a === b || (a.id === b.id && a.role === b.role && a.content === b.content && a.createdAt === b.createdAt
  && a.turnDurationMs === b.turnDurationMs && a.cut === b.cut && JSON.stringify(a.turnChanges) === JSON.stringify(b.turnChanges) && JSON.stringify(a.attachments) === JSON.stringify(b.attachments));

function sameRow(a: TurnRow, b: TurnRow): boolean {
  if (a.kind === 'changes') return b.kind === 'changes' && a.files === b.files && a.additions === b.additions && a.deletions === b.deletions;
  if (b.kind === 'changes') return false;
  if (a.kind === 'work') return b.kind === 'work' && a.durationMs === b.durationMs && a.steps.length === b.steps.length && a.steps.every((step, i) => sameMessage(step, b.steps[i]));
  return a.kind === b.kind && sameMessage(a.message, (b as Exclude<TurnRow, { kind: 'work' | 'changes' }>).message);
}

/** `next` with every unchanged row replaced by its object from `previous`, so a refetch of the same
 * messages leaves memoized rows alone. Returns `previous` itself when nothing changed. */
export function reuseRows(previous: readonly TurnRow[], next: TurnRow[]): TurnRow[] {
  const known = new Map(previous.map(row => [row.id, row]));
  const rows = next.map(row => {
    const old = known.get(row.id);
    return old && sameRow(old, row) ? old : row;
  });
  return rows.length === previous.length && rows.every((row, i) => row === previous[i]) ? previous as TurnRow[] : rows;
}

/** "41s", "2m", "1h 5m" */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

// Attachment headers the desktop writes into a prompt (src/attachments.ts, src/main.ts).
const ATTACHMENT = /\n\n(Attached image|Attached mockup|Attached browser screenshot|Document context|Folder context|File context): ([^\n]+?)(?: \(|\n|$)/g;

/** A prompt's attachments, by kind and file name, in order. */
export const attachments = (content: string): { kind: string; name: string }[] =>
  [...content.matchAll(ATTACHMENT)].map(m => ({ kind: m[1], name: m[2].split('/').at(-1) || m[2] }));
