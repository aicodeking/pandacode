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
  /** The reply was lost (timed out or the connection dropped), so the host may or may not have it:
   * shown as "Unconfirmed" until the thread's reload finds its copy (or the run ends). */
  unconfirmed?: true;
  /** Resolved from unconfirmed: the reload found no stored copy and the task is idle, so the
   * host never ran it. Shown as "Not delivered" with Send again / Discard until the user picks. */
  undelivered?: true;
  /** Local uris of the images it carries, for thumbnails on the bubble. */
  images?: string[];
}

/** The label a sent bubble shows: "Not delivered" and "Unconfirmed" override its state. */
export const sentLabel = (entry: Sent): string =>
  entry.undelivered ? 'Not delivered' : entry.unconfirmed ? 'Unconfirmed' : entry.state === 'steering' ? 'Steer · Sending…' : entry.state === 'queued' ? 'Queued' : 'Sending…';

/** Marks one entry unconfirmed (a may-have-run failure): it stays until the reload decides. */
export const unconfirm = (sent: readonly Sent[], id: string): Sent[] =>
  sent.map(e => (e.id === id && !e.unconfirmed ? { ...e, unconfirmed: true as const } : e));

/** Marks one unconfirmed entry undelivered (the host never ran it). */
export const undeliver = (sent: readonly Sent[], id: string): Sent[] =>
  sent.map(e => {
    if (e.id !== id || !e.unconfirmed) return e;
    const { unconfirmed: _gone, ...rest } = e;
    return { ...rest, undelivered: true as const };
  });

/** The list without one entry (sent again, discarded or handed to the outbox). */
export const withoutSent = (sent: readonly Sent[], id: string): Sent[] => sent.filter(e => e.id !== id);

/**
 * What to do with an unconfirmed entry once a thread reload that started after its lost reply
 * finished: `keep` while it is gone, already resolved, or the task still runs (its run's end
 * settles it); otherwise the host never stored it. A host that dedupes by `sendId` gets it back
 * through the outbox under the same id (`resend`: safe, a copy that did run answers from memory),
 * once (`resent` counts earlier hand-backs); else it shows `undelivered` for the user to decide.
 */
export function unconfirmedVerdict(entry: Sent | undefined, { idle, dedupes, resendable, resent }: { idle: boolean; dedupes: boolean; resendable: boolean; resent: number }): 'keep' | 'resend' | 'undelivered' {
  if (!entry?.unconfirmed || !idle) return 'keep';
  return dedupes && resendable && resent < MAX_RESENDS ? 'resend' : 'undelivered';
}

/** How many times one unconfirmed prompt goes back to the outbox before the user decides. */
export const MAX_RESENDS = 1;

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

/** At a run's end only queued entries can still be waiting; any other copy would be stored by now.
 * Undelivered ones stay until the user sends them again or discards them. */
const waits = (e: Sent) => e.state === 'queued' || !!e.undelivered;
export const settled = (sent: readonly Sent[]): Sent[] => (sent.some(e => !waits(e)) ? sent.filter(waits) : (sent as Sent[]));
