// Groups stored messages into transcript rows: a user prompt, then the turn's work (tools and
// interim notes, folded behind "Worked for 2m"), then the reply. Pure (tested in node).
import type { Message } from '../connect/types.ts';

export type TurnRow =
  | { kind: 'user'; id: string; message: Message }
  | { kind: 'work'; id: string; steps: Message[]; durationMs: number | null }
  | { kind: 'reply'; id: string; message: Message }
  | { kind: 'note'; id: string; message: Message };

export function turnRows(messages: readonly Message[]): TurnRow[] {
  const rows: TurnRow[] = [];
  let turn: Message[] = [];
  const close = () => {
    if (!turn.length) return;
    const replyIndex = turn.findLastIndex(m => m.role === 'assistant');
    const reply = replyIndex >= 0 ? turn[replyIndex] : undefined;
    const steps = turn.filter((m, i) => i !== replyIndex && m.role !== 'error');
    const durationMs = turn.reduce<number | null>((max, m) => (m.turnDurationMs != null && m.turnDurationMs > (max ?? -1) ? m.turnDurationMs : max), null);
    if (steps.length || durationMs != null) rows.push({ kind: 'work', id: `w${turn[0].id}`, steps, durationMs });
    // Errors stay visible after the work, and after a reply that came before them.
    for (const m of turn) if (m.role === 'error' && (!reply || m.id < reply.id)) rows.push({ kind: 'note', id: `n${m.id}`, message: m });
    if (reply) rows.push({ kind: 'reply', id: `r${reply.id}`, message: reply });
    for (const m of turn) if (m.role === 'error' && reply && m.id > reply.id) rows.push({ kind: 'note', id: `n${m.id}`, message: m });
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
