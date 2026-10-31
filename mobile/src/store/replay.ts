// Event cursors and replay paging for subscribe (docs/remote-access.md), the phone's copy of
// the desktop viewer in src-tauri/src/remote/mirror.rs: replay pages are followed while the
// host says `more`, and live frames that arrive meanwhile are held until the replay is shown,
// so a newer live `seq` never moves the cursor past events still to be replayed.
import type { AgentEvent, SubscribeReply, SubscribedTask } from '../connect/types.ts';

/** Replay pages per host and round; a replay longer still becomes a gap. */
export const MAX_REPLAY_PAGES = 20;
/** Live events held per host while its subscribe is in flight; past this they are dropped and the host is asked again. */
export const MAX_HELD = 4096;

export interface Held { entries: { epoch: unknown; events: AgentEvent[] }[]; overflow: boolean }

export class Cursors {
  /** Per host: its journal epoch (new with every host launch) and the newest `seq` seen per task. */
  private known = new Map<string, { epoch: string; seqs: Map<string, number> }>();
  private held = new Map<string, Held & { count: number }>();

  clear() {
    this.known.clear();
    this.held.clear();
  }

  /** Moves to a host's epoch: a new one (the host restarted) forgets its old `seq`s. */
  private at(host: string, epoch: unknown) {
    let known = this.known.get(host);
    if (typeof epoch === 'string' && known?.epoch !== epoch) this.known.set(host, known = { epoch, seqs: new Map() });
    return known;
  }

  /** Drops events already seen, advancing past the rest. Older hosts send no `seq`. */
  fresh(host: string, epoch: unknown, list: AgentEvent[]): AgentEvent[] {
    const known = this.at(host, epoch);
    if (!known) return list;
    return list.filter(event => {
      if (typeof event?.seq !== 'number' || typeof event.sessionId !== 'string') return true;
      if (event.seq <= (known.seqs.get(event.sessionId) ?? 0)) return false;
      known.seqs.set(event.sessionId, event.seq);
      return true;
    });
  }

  /** `subscribe` params: the tasks, and where this viewer left off in each it has seen. */
  params(host: string, ids: string[]) {
    const known = this.known.get(host);
    if (!known) return { sessionIds: ids };
    return { sessionIds: ids, epoch: known.epoch, afterSeq: Object.fromEntries(ids.flatMap(id => known.seqs.has(id) ? [[id, known.seqs.get(id)!]] : [])) };
  }

  /** Moves to a reply's `seq` for a task. One with no position was not replayed, so its held live events set it instead. */
  settle(host: string, epoch: unknown, session: string, seq: number) {
    const known = this.at(host, epoch);
    if (!known) return;
    const unknown = !known.seqs.has(session);
    if (unknown && this.held.get(host)?.entries.some(e => e.events.some(event => event?.sessionId === session))) return;
    known.seqs.set(session, Math.max(known.seqs.get(session) ?? 0, seq));
  }

  hold(host: string) {
    if (!this.held.has(host)) this.held.set(host, { entries: [], overflow: false, count: 0 });
  }

  /** Keeps live events while the host is held; false when it is not. */
  keep(host: string, epoch: unknown, events: AgentEvent[]): boolean {
    const held = this.held.get(host);
    if (!held) return false;
    if (held.count + events.length > MAX_HELD) held.overflow = true;
    else {
      held.entries.push({ epoch, events });
      held.count += events.length;
    }
    return true;
  }

  release(host: string): Held {
    const held = this.held.get(host);
    this.held.delete(host);
    return { entries: held?.entries ?? [], overflow: held?.overflow ?? false };
  }
}

export interface Followed {
  /** The first page's reply (its epoch), or null when the first call failed. */
  reply: SubscribeReply | null;
  /** The newest snapshot of each task; ones whose replay was cut short carry `gap: true`. */
  tasks: SubscribedTask[];
  /** Live events that arrived meanwhile, to show after the snapshot. */
  held: Held;
  error?: unknown;
}

/** Subscribes and follows the replay pages (`more`), holding live events meanwhile. `show`
 * gets each page's replayed events in order; the caller shows `held` after the snapshot. */
export async function followReplay(cursors: Cursors, host: string, ids: string[], call: (params: object) => Promise<SubscribeReply>, show: (events: AgentEvent[], epoch: unknown) => void): Promise<Followed> {
  cursors.hold(host);
  let asked = ids, reply: SubscribeReply | null = null, error: unknown, cut = false;
  let tasks: SubscribedTask[] = [];
  for (let page = 1; page <= MAX_REPLAY_PAGES; page++) {
    let next: SubscribeReply;
    try {
      next = await call(cursors.params(host, asked));
    } catch (e) {
      error = e;
      break;
    }
    reply ??= next;
    const list = Array.isArray(next?.tasks) ? next.tasks : [];
    for (const t of list) if (Array.isArray(t.events) && t.events.length) show(t.events, next.epoch);
    for (const t of list) if (typeof t.seq === 'number') cursors.settle(host, next.epoch, t.sessionId, t.seq);
    // Later pages carry newer snapshots of the tasks they continue.
    tasks = [...tasks.filter(t => !list.some(n => n.sessionId === t.sessionId)), ...list];
    const more = list.filter(t => t.more === true).map(t => t.sessionId);
    if (next?.more !== true || !more.length) {
      asked = [];
      break;
    }
    asked = more;
    if (page === MAX_REPLAY_PAGES) cut = true;
  }
  // A replay cut short (or a later page lost): the messages copy catches those tasks up.
  if (reply && (cut || error !== undefined)) tasks = tasks.map(t => asked.includes(t.sessionId) ? { ...t, gap: true } : t);
  return { reply, tasks, held: cursors.release(host), error };
}
