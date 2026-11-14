/** Host-only bridge between the lazily mounted status surfaces (agent-usage.ts, progress-pip.ts, jev-activity.ts) and
 * their presentation adoption (status-host.ts, docs/extensions/status.md). No package reaches it: it carries host state
 * readers, never account data, and it imports nothing so the surfaces stay lazy. */
export type UsageRange = 'week' | 'month' | 'year';
export type UsageReadStatus = 'checking' | 'ready' | 'unavailable' | 'signedOut' | 'error' | 'unsupported';
export type UsageView = {
  host: HTMLElement;
  /** `overview` or a harness id. */
  tab(): string;
  range(): UsageRange;
  breakdown(): 'model' | 'day';
  pending(): boolean;
  providers(): { id: string; status: UsageReadStatus; peak: number | null; stale: boolean }[];
  /** Details-first (the cost breakdown ahead of the agent list) or the built-in order; the same nodes either way. */
  arrange(detailsFirst: boolean): void;
};
/** Fired after a status surface mounts, redraws or changes state, so the adoption re-applies its layout. */
export const STATUS_EVENT = 'pandacode:status';
let usage: UsageView | undefined, detailsFirst = false;
export function statusChanged(): void { dispatchEvent(new Event(STATUS_EVENT)); }
/** The open usage panel, or undefined once it is disposed. A new panel takes the current arrangement. */
export function publishUsage(view: UsageView | undefined): void {
  usage = view; view?.arrange(detailsFirst); statusChanged();
}
export function activeUsage(): UsageView | undefined { return usage; }
export function setUsageArrangement(on: boolean): void {
  if (detailsFirst === on) return;
  detailsFirst = on; usage?.arrange(on);
}
