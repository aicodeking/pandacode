// One vocabulary for an account's health, shared by Settings → Providers (connections.ts) and the Usage panel
// (agent-usage.ts): the chip's words and tone, the meter's tone and the plan shown beside the email.
import type { AgentUsage, UsageWindow } from './agent-usage';

/** A member of `account_pool_status` (`account_pool.rs`). */
export interface PoolMember {
  id: string; excluded: boolean; sameAs: string | null; limitedUntil: number | null; nearUntil: number | null;
  active?: number; signedIn: boolean; email?: string | null; plan?: string | null; limitedWindow?: string | null;
}
export type ChipTone = '' | 'ready' | 'near' | 'limited';
export type MeterTone = 'normal' | 'warn' | 'danger';
/** A window at or past this share of its limit puts the account near it (chip and meter agree). */
export const NEAR_PERCENT = 90;
const WARN_PERCENT = 70;

/** A time, with the weekday when it is not today. */
export function until(at: number): string {
  const date = new Date(at), time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
/** The limit an account ran into, from the CLI's window name (`five_hour`, `seven_day`, …). Model-family windows
 *  (`seven_day_opus`, `seven_day_sonnet`) never reach it: the pool only marks those accounts near, never limited. */
export function windowLimitLabel(window: string | null | undefined): string {
  return window?.startsWith('five_hour') ? '5-hour limit' : window?.startsWith('seven_day') ? 'Weekly limit' : 'Limit';
}
/** When a window resets, in the same words as the chip's "until …": 'resets 1:31 PM', 'resets Sat 11:24 AM'. */
export function resetsAt(at: number): string {
  return at <= Date.now() ? 'reset due' : `resets ${until(at)}`;
}
/** Up to two reported windows, labelled without a trailing "window" ("5-hour", "Weekly"). */
export function accountWindows(usage: AgentUsage | null | undefined): UsageWindow[] {
  return (usage?.status === 'ready' ? usage.windows : []).filter(w => Number.isFinite(w.usedPercent)).slice(0, 2).map(w => ({ ...w, label: w.label.replace(/\s+window$/i, '') }));
}
/** Fresh windows (not a saved snapshot), or null when usage is unknown. */
function freshWindows(usage: AgentUsage | null | undefined): UsageWindow[] | null {
  const windows = usage && !usage.stale ? accountWindows(usage) : [];
  return windows.length ? windows : null;
}
/** The chip: neutral for sign-in and pool states, amber only near a limit; fresh usage decides Near limit. */
export function accountState(member: PoolMember, usage: AgentUsage | null | undefined): { tone: ChipTone; text: string } {
  if (member.sameAs !== null) return { tone: '', text: 'Same login' };
  if (!member.signedIn) return { tone: '', text: 'Not signed in' };
  if (member.excluded) return { tone: '', text: 'Left out' };
  if (member.limitedUntil) return { tone: 'limited', text: `${windowLimitLabel(member.limitedWindow)} · until ${until(member.limitedUntil)}` };
  const windows = freshWindows(usage), near = windows ? windows.some(w => w.usedPercent >= NEAR_PERCENT) : member.nearUntil !== null;
  return near ? { tone: 'near', text: 'Near limit' } : { tone: 'ready', text: 'Ready' };
}
/** Whether a meter is the window that holds the account (when the CLI did not say which, a nearly full one). */
function heldBy(member: PoolMember | null | undefined, label: string, percent: number): boolean {
  if (!member?.limitedUntil) return false;
  const window = member.limitedWindow ?? '';
  return window.startsWith('five_hour') ? /5.?h|five/i.test(label) : window.startsWith('seven_day') ? /week|7.?d|seven/i.test(label) : percent >= NEAR_PERCENT;
}
/** Muted below 70 %, warn up to 99 %, danger only when full or when this window actually holds the account. */
export function meterTone(percent: number, member?: PoolMember | null, label = ''): MeterTone {
  return percent >= 100 || heldBy(member, label, percent) ? 'danger' : percent >= WARN_PERCENT ? 'warn' : 'normal';
}
/** The plan beside the email: the login's own first, then what the usage check reported. */
export function accountPlan(member: PoolMember | null | undefined, usage: AgentUsage | null | undefined): string | null {
  if (member && !member.signedIn) return null;
  return member?.plan ?? usage?.plan ?? null;
}
