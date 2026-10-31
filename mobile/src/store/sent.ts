// Prompts this phone sent that the stored transcript doesn't hold yet, shown as optimistic
// bubbles until the host's copy arrives. Pure (tested in node); client.ts keeps the list.
import type { Message } from '../connect/types.ts';

export interface Sent {
  id: string;
  text: string;
  /** sending: on its way or its turn is running; steering: a steer; queued: the host queued it behind the run. */
  state: 'sending' | 'steering' | 'queued';
  /** The last stored message id when it was sent: only later messages can be its copy. */
  after: number;
}

/** The host trims prompts; a desktop may append context blocks after a blank line. */
const copyOf = (message: Message, text: string) => {
  const content = message.content.trim();
  return content === text || content.startsWith(`${text}\n\n`);
};

/** Entries no stored user message accounts for, in order. Each stored message stands for at most one entry. */
export function unmatched(sent: readonly Sent[], messages: readonly Message[]): Sent[] {
  if (!sent.length) return sent as Sent[];
  const used = new Set<number>();
  const left = sent.filter(entry => {
    const text = entry.text.trim();
    const copy = messages.find(m => m.id > entry.after && m.role === 'user' && !used.has(m.id) && copyOf(m, text));
    if (copy) used.add(copy.id);
    return !copy;
  });
  return left.length === sent.length ? (sent as Sent[]) : left;
}

/** A new turn started: the oldest queued entry is the prompt being delivered. */
export function delivering(sent: readonly Sent[]): Sent[] {
  const index = sent.findIndex(e => e.state === 'queued');
  return index < 0 ? (sent as Sent[]) : sent.map((e, i) => (i === index ? { ...e, state: 'sending' as const } : e));
}

/** At a run's end only queued entries can still be waiting; any other copy would be stored by now. */
export const settled = (sent: readonly Sent[]): Sent[] => (sent.some(e => e.state !== 'queued') ? sent.filter(e => e.state === 'queued') : (sent as Sent[]));
