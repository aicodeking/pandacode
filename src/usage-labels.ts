/* Usage card state labels, shared by the Agent usage panel and the menu bar popover. */
import type { AgentUsage } from './agent-usage';
import { escape } from './dom';
import { isWindows } from './platform';

/** What fixes an error, as the backend names it (`Usage::action`). */
export type UsageAction = 'refresh' | 'retry' | 'claude' | 'unlock' | 'rateLimited' | 'apiConnection' | 'updateClaude' | 'settings' | 'expired';

const STATUS: Record<AgentUsage['status'], string> = { ready: '', unavailable: 'Unavailable', signedOut: 'Sign-in needed', error: 'Unavailable', unsupported: 'Not exposed' };
/** Labels for errors whose fix the backend names; a sign-out keeps "Sign-in needed". */
const ACTION_LABEL: Record<UsageAction, string> = { refresh: 'Needs refresh', retry: 'Temporary problem', claude: 'Sign in via Claude Code', unlock: 'Keychain locked', rateLimited: 'Rate limited', apiConnection: 'Not your subscription', updateClaude: 'Update Claude Code', settings: 'Login expired', expired: 'Login expired' };
/** Words kept capitalized when a label follows "Saved ·". */
const PROPER = new Set(['Keychain', 'Claude']);

/** Why a saved snapshot stands in, from the same label: "Rate limited" → "rate limited". */
function savedCause(action: UsageAction): string {
  const [first, ...rest] = ACTION_LABEL[action].split(' ');
  return [PROPER.has(first) ? first : first.toLowerCase(), ...rest].join(' ');
}

/** Actions that need attention even on a fresh reading (a Keychain latch shown beside readable limits). */
const READY_ATTENTION = new Set<UsageAction>(['refresh']);

/** A card's state label: what fixes an error when the backend says so (e.g. "Needs refresh"), else its status. A fresh reading that still needs attention says so too. A saved snapshot names its cause when known ("Saved · rate limited"). */
export function statusLabel(result: Pick<AgentUsage, 'status' | 'stale' | 'action'> & { retryAt?: number | null }, now = Date.now()): string {
  if (result.stale) return result.action ? `Saved · ${savedCause(result.action)}` : 'Saved snapshot';
  // An expired login whose extra run a Refresh already used: when Claude Code may be asked again.
  if (result.action === 'expired' && (result.retryAt ?? 0) > now) return `Next try after ${clockLabel(result.retryAt!, now)}`;
  const label = result.action ? ACTION_LABEL[result.action] : undefined;
  if (label && (result.status === 'error' || result.status === 'unavailable')) return label;
  if (label && result.status === 'ready' && READY_ATTENTION.has(result.action!)) return label;
  return STATUS[result.status] ?? 'Unavailable';
}

/** A time of day, with the date when it is not today: "9:05 AM", or "Nov 8, 9:05 AM". */
export function clockLabel(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return date.toDateString() === new Date(now).toDateString() ? time : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/** The reset as Claude Code printed it ("resets Nov 15 at 8pm (…)"), when a window has no timestamp; other details are not reset text. One whose date has passed is left out (`printedPassed`). */
export function printedReset(window: { resetsAt?: string | null; detail?: string | null }, now = Date.now()): string {
  const at = window.resetsAt ? new Date(window.resetsAt).getTime() : NaN;
  const detail = window.detail ?? '';
  return !Number.isFinite(at) && /^resets\s/i.test(detail) && !printedPassed(detail, now) ? detail : '';
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const HALF_YEAR = 183 * 86_400_000;

/** Whether a printed "Resets Nov 15 at 8pm (…)" has passed, read as local time in this year (a date over half a year back is next year's). Without a date ("resets 3pm"), or unreadable, it has not. */
export function printedPassed(detail: string, now = Date.now()): boolean {
  const match = /^resets\s+([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm))?/i.exec(detail);
  const month = match ? MONTHS.indexOf(match[1].toLowerCase()) : -1;
  if (!match || month < 0) return false;
  const hour = match[3] ? Number(match[3]) % 12 + (match[5].toLowerCase() === 'pm' ? 12 : 0) : 24;
  const at = new Date(new Date(now).getFullYear(), month, Number(match[2]), hour, Number(match[4] ?? 0)).getTime();
  return at < now && now - at < HALF_YEAR;
}

/** The line that signs Claude Code (or Codex) in, with its config folder when it has its own, quoted for the platform's shell. */
export function signInCommand(provider: string, dir?: string): string {
  const [variable, login] = provider === 'codex' ? ['CODEX_HOME', 'codex login'] : ['CLAUDE_CONFIG_DIR', 'claude auth login'];
  if (!dir) return login;
  return isWindows ? `$env:${variable}='${dir.replace(/['\u2018-\u201B]/g, '$&$&')}'; ${login}; Remove-Item Env:${variable}` : `${variable}='${dir.replace(/'/g, "'\\''")}' ${login}`;
}

const copyButton = (command: string, hint: string) =>
  `<p class="usage-fix-hint">${hint.replace('{command}', `<code>${escape(command)}</code>`)}</p><button type="button" class="secondary-button usage-fix" data-usage-copy="${escape(command)}">Copy command</button>`;

/** The button for a fix PandaCode can start or hand over: Settings for a switch that is off; the sign-in (`dir`: the setup's own config folder) or update command to copy, with what to do with it; Refresh for a passing problem, an expired login or a Keychain to unlock, and for a rate limit once the server's wait ends (disabled until `retryAt`). A Refresh that can't run Claude Code yet (`retryAt`) still reads again; `data-until` marks when the card's "Next try after" ends. */
export function fixButton(action: UsageAction | null | undefined, retryAt?: number | null, now = Date.now(), dir?: string): string {
  if (action === 'settings') return '<button type="button" class="secondary-button usage-fix" data-action="settings-page" data-id="providers" data-reveal="claude-cli-refresh">Open Settings</button>';
  if (action === 'claude') return `${copyButton(signInCommand('claude', dir), 'Run {command} in a terminal, or /login in Claude Code, then press Refresh.')}<button type="button" class="secondary-button usage-fix" data-usage-refresh>Refresh</button>`;
  if (action === 'updateClaude') return copyButton('claude update', 'Run {command} in a terminal, then press Refresh.');
  if (action === 'rateLimited') return `<button type="button" class="secondary-button usage-fix" data-usage-refresh${(retryAt ?? 0) > now ? ` data-until="${retryAt}" data-wait disabled` : ''}>Refresh</button>`;
  // A Refresh always reads the login and the service again; only its run of Claude Code waits (`data-until`).
  if (action === 'expired' && (retryAt ?? 0) > now) return `<button type="button" class="secondary-button usage-fix" data-usage-refresh data-until="${retryAt}">Refresh</button>`;
  if (action === 'refresh' || action === 'retry' || action === 'expired' || action === 'unlock') return '<button type="button" class="secondary-button usage-fix" data-usage-refresh>Refresh</button>';
  return '';
}
