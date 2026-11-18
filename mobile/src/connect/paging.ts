// task.messages paging that works with every host: newer hosts answer `tail` and `beforeId`
// pages with `hasOlder`; older ones ignore those params (answering as for afterId 0) or refuse
// them, and then only afterId paging is used. Pure over `call`: tests/paging.test.ts covers it.
import type { Message, MessagePage } from './types.ts';
import { LOST, NOT_CONNECTED, OFFLINE, RATE } from './rpc.ts';

export type Fetch = (params: object) => Promise<MessagePage>;

const TRANSPORT = new Set([OFFLINE, RATE, LOST, NOT_CONNECTED]);
/** A refusal of the tail/beforeId params themselves (an older host's validation), not a failed call. */
export const refusesParams = (message: string) => !TRANSPORT.has(message) && /unknown|invalid|unexpected|expected|param/i.test(message);

export const pageMessages = (reply: MessagePage | null | undefined): Message[] => (Array.isArray(reply?.messages) ? reply.messages : []);

/** A tail or beforeId page. `legacy`: the host has neither (remembered in `legacyHosts`);
 * `page` is then its answer as for afterId 0, or null if it refused the params. */
export async function newestPage(fetch: Fetch, host: string, legacyHosts: Set<string>, params: object): Promise<{ page: MessagePage | null; legacy: boolean }> {
  if (legacyHosts.has(host)) return { page: null, legacy: true };
  let reply: MessagePage | null = null;
  try {
    reply = await fetch(params);
    if (typeof reply?.hasOlder === 'boolean') return { page: reply, legacy: false };
  } catch (error) {
    if (!refusesParams((error as Error).message)) throw error;
  }
  legacyHosts.add(host);
  return { page: reply, legacy: true };
}

/** An older host's history before `first`: afterId pages from the start (beginning with `start`,
 * its answer to a beforeId request, when there is one) up to the first message held. */
export async function olderByAfterId(fetch: Fetch, first: number, start: MessagePage | null, maxPages: number): Promise<Message[]> {
  const found: Message[] = [];
  let reply = start;
  for (let n = 0; n < maxPages; n++) {
    reply ??= await fetch({ afterId: found.at(-1)?.id ?? 0 });
    const messages = pageMessages(reply);
    found.push(...messages.filter(m => m.id < first));
    if (!reply?.hasMore || !messages.length || messages[messages.length - 1].id >= first) break;
    reply = null;
  }
  return found;
}

/** A window of a worker's transcript. `hasOlder`: `workerOlder` can go on backward. `hasMore`:
 * newer rows were left unread at the page cap. */
export interface WorkerPage { messages: Message[]; hasOlder: boolean; hasMore: boolean }

/** Worker rows after `afterId`, forward. `start` is a reply already in hand for that position. */
export async function workerNewer(fetch: Fetch, afterId: number, maxPages: number, start?: MessagePage): Promise<WorkerPage> {
  let found: Message[] = [];
  let cursor = afterId;
  let reply = start;
  for (let n = 0; n < maxPages; n++) {
    reply ??= await fetch(cursor ? { afterId: cursor } : {});
    const fresh = pageMessages(reply).filter(m => typeof m?.id === 'number' && m.id > cursor);
    found = [...found, ...fresh];
    if (!reply?.hasMore || !fresh.length) return { messages: found, hasOlder: false, hasMore: false };
    cursor = fresh[fresh.length - 1].id;
    reply = undefined;
  }
  return { messages: found, hasOlder: false, hasMore: true };
}

/** A worker's newest page, whatever the transcript's size. An older host ignores `tail` and has
 * no backward pages, so it is read forward from the start, up to the page cap. */
export async function workerNewest(fetch: Fetch, maxPages: number): Promise<WorkerPage> {
  const reply = await fetch({ tail: true });
  if (reply?.tail !== true) return workerNewer(fetch, 0, maxPages, reply);
  return { messages: pageMessages(reply), hasOlder: reply.hasOlder === true, hasMore: false };
}

/** The page before `beforeId`; an older host has none to give. */
export async function workerOlder(fetch: Fetch, beforeId: number): Promise<WorkerPage> {
  const reply = await fetch({ beforeId });
  if (reply?.tail !== true) return { messages: [], hasOlder: false, hasMore: false };
  const messages = pageMessages(reply).filter(m => m.id < beforeId);
  return { messages, hasOlder: reply.hasOlder === true && messages.length > 0, hasMore: false };
}
