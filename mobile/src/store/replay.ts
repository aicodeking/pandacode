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

/** `Cursors.check`: the events to show, and the tasks whose events show an earlier one never
 * arrived (their events from there on are dropped and their positions kept, for a resubscribe). */
export interface Checked { events: AgentEvent[]; gaps: string[] }

/** Saved positions per host (resume tokens): its journal epoch and the newest `seq` per task. */
export type SavedCursors = Record<string, { epoch: string; seqs: Record<string, number> }>;
/** Saved positions older than this are not used: the host's journal has dropped them by then. */
export const CURSORS_MAX_AGE_MS = 60 * 60_000;
const MAX_SAVED_HOSTS = 64;
const MAX_SAVED_TASKS = 500;
const ID = /^[\x21-\x7e]{1,200}$/;

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
    return this.check(host, epoch, list).events;
  }

  /** `fresh`, and a gap where an event's `prev` (newer hosts) is past this viewer's position in its
   * task: that task's events stop there, unadvanced, so a subscribe replays them. A task with no
   * position yet, or an event without `prev` (older hosts), is never a gap. */
  check(host: string, epoch: unknown, list: AgentEvent[]): Checked {
    const known = this.at(host, epoch);
    if (!known) return { events: list, gaps: [] };
    const gaps = new Set<string>();
    const events = list.filter(event => {
      if (typeof event?.seq !== 'number' || typeof event.sessionId !== 'string') return true;
      if (gaps.has(event.sessionId)) return false;
      const seen = known.seqs.get(event.sessionId);
      if (seen !== undefined && typeof event.prev === 'number' && event.prev > seen) {
        gaps.add(event.sessionId);
        return false;
      }
      if (event.seq <= (seen ?? 0)) return false;
      known.seqs.set(event.sessionId, event.seq);
      return true;
    });
    return { events, gaps: [...gaps] };
  }

  /** Every host's epoch and positions, to save (bounded). */
  snapshot(): SavedCursors {
    const out: SavedCursors = {};
    for (const [host, known] of [...this.known].slice(0, MAX_SAVED_HOSTS)) {
      out[host] = { epoch: known.epoch, seqs: Object.fromEntries([...known.seqs].slice(-MAX_SAVED_TASKS)) };
    }
    return out;
  }

  /** Saved positions after a relaunch; a host this run already knows keeps its own. A subscribe
   * then sends them with the epoch, and the host replays from them only if it was not restarted. */
  restore(saved: SavedCursors) {
    for (const [host, { epoch, seqs }] of Object.entries(saved)) {
      if (this.known.has(host)) continue;
      this.known.set(host, { epoch, seqs: new Map(Object.entries(seqs)) });
    }
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

/** Validates saved cursors (file content is untrusted input); too old or malformed → none. */
export function parseCursors(raw: string | null, now: number, maxAgeMs = CURSORS_MAX_AGE_MS): SavedCursors {
  try {
    const value = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object' || typeof value.savedAt !== 'number' || now - value.savedAt > maxAgeMs || now < value.savedAt - 60_000) return {};
    const hosts = value.hosts && typeof value.hosts === 'object' ? Object.entries(value.hosts as Record<string, any>) : [];
    const out: SavedCursors = {};
    for (const [host, entry] of hosts.slice(0, MAX_SAVED_HOSTS)) {
      if (!ID.test(host) || typeof entry?.epoch !== 'string' || !ID.test(entry.epoch) || !entry.seqs || typeof entry.seqs !== 'object') continue;
      const seqs = Object.entries(entry.seqs as Record<string, unknown>).slice(0, MAX_SAVED_TASKS)
        .filter((e): e is [string, number] => ID.test(e[0]) && typeof e[1] === 'number' && Number.isSafeInteger(e[1]) && e[1] >= 0);
      if (seqs.length) out[host] = { epoch: entry.epoch, seqs: Object.fromEntries(seqs) };
    }
    return out;
  } catch {
    return {};
  }
}

export const encodeCursors = (cursors: SavedCursors, now: number) => JSON.stringify({ savedAt: now, hosts: cursors });

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
