// Undo for a queued message removed on the Queue screen, on hosts without `queue.restore`
// (composer.ts restoreRemoved, which puts back the exact entry). Older hosts have no queue.add, so the
// message goes back the way the composer queues one (task.send queues behind a running turn) and
// queue.reorder puts it at its old place. If the run has ended meanwhile, task.send sends it now, which
// is what the queue would have done had it never been removed. The send carries a sendId and is retried
// once on a lost reply where the host dedupes it (github.ts runOnce), so it never queues twice.
import { placedAt, readdedId } from '../../store/queue-order.ts';
import type { QueuedEntry } from '../../store/slash.ts';
import { hostCall } from '../client.ts';
import { capabilitiesOf } from './capabilities.ts';
import { loadQueue, reorderQueue } from './composer.ts';
import { runOnce } from './github.ts';

export type Restored = 'queued' | 'sent';

/** Re-adds `entry` (removed from `before`, the host's order then) at its old position. */
export async function restoreQueued(deviceId: string, sessionId: string, entry: QueuedEntry, before: readonly string[]): Promise<Restored> {
  const index = before.indexOf(entry.id);
  const others = before.filter(id => id !== entry.id);
  const caps = capabilitiesOf(deviceId);
  const dedupes = caps?.kind === 'hello' && caps.features.has('sendId');
  const reply = await runOnce(sendId => hostCall<{ queued?: boolean }>(deviceId, 'task.send', { sessionId, text: entry.text, ...(sendId && { sendId }) }), dedupes);
  if (!reply?.queued) { void loadQueue(deviceId, sessionId).catch(() => undefined); return 'sent'; }
  const now = await loadQueue(deviceId, sessionId);
  const id = readdedId(others, now, entry.text);
  const ids = now.map(e => e.id);
  if (id && index >= 0) {
    const order = placedAt(ids, id, index);
    if (order.some((other, n) => other !== ids[n])) await reorderQueue(deviceId, sessionId, order);
  }
  return 'queued';
}
