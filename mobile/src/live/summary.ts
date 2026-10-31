// What the Live Activity shows: one summary of every computer's running and waiting tasks, from the
// inbox sections (src/store/inbox.ts). Pure (tested in node); LiveActivityHost.tsx pushes it.
import type { Inbox, InboxRow } from '../store/inbox.ts';

export type LiveStatus = 'approval' | 'input' | 'working' | 'done' | 'failed';

export interface LiveRow { key: string; title: string; project: string; status: LiveStatus }

/** The Live Activity's props: plain JSON, read by the layout in PandaActivity.tsx. */
export interface LiveSummary {
  /** "3 active agents · 2 need attention", or "All done". */
  headline: string;
  active: number;
  attention: number;
  /** Lock Screen rows, needs first, then working, then tasks that finished while it was up. */
  rows: LiveRow[];
  /** Local time of the data, shown once the activity goes stale ("9:41"). */
  updated: string;
  /** file:// URL of the panda mark (white on transparent, src/live/mark.png) in the shared widgets directory, or '' (SF Symbol fallback). */
  mark: string;
  /** The deep link: the task when it is the only one, else the inbox. Applied by the layout with
   *  widgetURL (start-time URLs can't change on update). */
  url: string;
}

export const MAX_ROWS = 4;

const statusOf = (row: InboxRow): LiveStatus =>
  row.badge === 'approval' ? 'approval' : row.badge === 'question' ? 'input' : row.badge === 'working' ? 'working' : row.badge === 'failed' ? 'failed' : 'done';

const toRow = (row: InboxRow): LiveRow => ({ key: row.key, title: row.task.title || 'New task', project: row.task.chat ? 'Chat' : row.task.projectName, status: statusOf(row) });

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function headline(active: number, attention: number): string {
  if (!active) return 'All done';
  const agents = plural(active, 'active agent', 'active agents');
  return attention ? `${agents} · ${attention} need${attention === 1 ? 's' : ''} attention` : agents;
}

export interface Summarized {
  summary: LiveSummary;
  /** Keys of every task this activity has shown active, so finished ones stay as Done rows. */
  tracked: ReadonlySet<string>;
}

/**
 * `tracked` is the previous result's set (empty for a new activity). Snoozed tasks stay out, as in
 * the inbox's Running and Needs you sections.
 */
export function summarize(inbox: Inbox, tracked: ReadonlySet<string>, updated: string, mark: string): Summarized {
  const waiting = inbox.needs.filter(r => r.badge === 'approval' || r.badge === 'question');
  const active = [...waiting, ...inbox.running];
  const finished = [...inbox.recent, ...inbox.needs.filter(r => !waiting.includes(r)), ...inbox.settled].filter(r => tracked.has(r.key));
  const rows = [...active, ...finished].map(toRow);
  const next = new Set([...tracked, ...active.map(r => r.key)]);
  const single = active.length === 1 ? active[0] : rows.length === 1 ? [...active, ...finished][0] : null;
  const url = single ? `pandacode://task/${encodeURIComponent(single.deviceId)}/${encodeURIComponent(single.task.sessionId)}` : 'pandacode://inbox';
  return {
    summary: { headline: headline(active.length, waiting.length), active: active.length, attention: waiting.length, rows: rows.slice(0, MAX_ROWS), updated, mark, url },
    tracked: next,
  };
}
