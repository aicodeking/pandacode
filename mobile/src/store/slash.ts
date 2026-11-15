// Pure logic for the composer's slash menu, /btw, the host queue and the usage screen, so tests can
// cover it without React Native (tests/slash.test.ts, tests/usage.test.ts).

/** One command as slash.list sends it (src-tauri/src/remote/methods/composer.rs). */
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string | null;
  kind: string;
  source: string;
  reason?: string | null;
  /** An app control (`btw`, `model`, `init`...), else the command is text for the harness. */
  action?: string | null;
  /** False for commands only the harness's terminal can run. */
  available: boolean;
}

/** `slash.resolve`: send `send` with task.send, or act on `action`. */
export interface SlashResolution { action: string | null; arguments: string; acceptsAttachments: boolean; send: string | null }

/** The desktop composer's test for a command (src/main.ts). */
const COMMAND = /^\/(?:[\p{L}\p{N}_:.-]+|\?)(?:\s|$)/u;
export const isSlashText = (text: string) => COMMAND.test(text.trimStart());

/** The menu's filter while the draft is a lone `/name` being typed, else null (closed). */
export function slashQuery(text: string): string | null {
  const match = /^\/([\p{L}\p{N}_:.-]*)$/u.exec(text);
  return match ? match[1].toLowerCase() : null;
}

/** How many rows the menu shows at most. */
export const MENU_LIMIT = 40;

/** Name prefix first, then a name match, then a description match; terminal-only commands last. */
export function filterCommands(commands: readonly SlashCommand[], query: string, limit = MENU_LIMIT): SlashCommand[] {
  const q = query.toLowerCase();
  const rank = (c: SlashCommand) => {
    const name = c.name.replace(/^\//, '').toLowerCase();
    const score = !q || name.startsWith(q) ? 0 : name.includes(q) ? 1 : c.description.toLowerCase().includes(q) ? 2 : -1;
    return score < 0 ? -1 : score + (c.available ? 0 : 3);
  };
  return commands
    .map((command, index) => ({ command, index, score: rank(command) }))
    .filter(entry => entry.score >= 0)
    .sort((a, b) => a.score - b.score || a.command.name.localeCompare(b.command.name) || a.index - b.index)
    .slice(0, limit)
    .map(entry => entry.command);
}

/** What picking a command puts in the draft: the name and a space, for its arguments. */
export const insertCommand = (command: Pick<SlashCommand, 'name'>) => `${command.name} `;

/** `/btw` → `''`, `/btw ask this` → `'ask this'`, anything else → null (parseBtw in src/btw.ts). */
export function parseBtw(text: string): string | null {
  const match = /^\/btw(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? (match[1] ?? '').trim() : null;
}

/** What the phone does with an app control from slash.resolve. */
export type PhoneAction =
  | { kind: 'route'; pathname: '/task-settings' | '/new-task' | '/changes' | '/task-info' | '/usage'; focus?: string }
  | { kind: 'btw' }
  | { kind: 'menu' }
  | { kind: 'send' }
  | { kind: 'unsupported' };

export function phoneAction(action: string | null | undefined): PhoneAction {
  switch (action) {
    case null: case undefined: case 'init': case 'recap': return { kind: 'send' };
    case 'btw': return { kind: 'btw' };
    case 'model': return { kind: 'route', pathname: '/task-settings', focus: 'model' };
    case 'permissions': return { kind: 'route', pathname: '/task-settings', focus: 'mode' };
    case 'new': return { kind: 'route', pathname: '/new-task' };
    case 'diff': return { kind: 'route', pathname: '/changes' };
    case 'status': case 'pwd': return { kind: 'route', pathname: '/task-info' };
    case 'usage': return { kind: 'route', pathname: '/usage' };
    case 'help': case 'skills': return { kind: 'menu' };
    default: return { kind: 'unsupported' };
  }
}

/** Whether the phone can run a listed command at all. */
export const runsOnPhone = (command: Pick<SlashCommand, 'action' | 'available'>) => command.available && phoneAction(command.action).kind !== 'unsupported';

/** The note for a command the phone can't run. */
export const unsupportedNote = (name: string) => `${name} opens a PandaCode control on your computer. Run it there, or ask the agent in plain text.`;

// ---- Queue ----

/** One entry as queue.list sends it. */
export interface QueuedEntry { id: string; position: number; text: string; truncated: boolean; attachments: number; createdAt: number; updatedAt: number }

/** `ids` with the entry at `from` moved by `by` places, clamped to the list. */
export function moved<T>(ids: readonly T[], from: number, by: number): T[] {
  const to = Math.max(0, Math.min(ids.length - 1, from + by));
  if (from < 0 || from >= ids.length || to === from) return [...ids];
  const next = [...ids];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** queue.list replies, dropping malformed rows. */
export function decodeQueue(reply: unknown): QueuedEntry[] {
  const entries = (reply as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) return [];
  return entries.filter((e): e is QueuedEntry => !!e && typeof e.id === 'string' && typeof e.text === 'string')
    .map(e => ({ id: e.id, position: Number(e.position) || 0, text: e.text, truncated: !!e.truncated, attachments: Number(e.attachments) || 0, createdAt: Number(e.createdAt) || 0, updatedAt: Number(e.updatedAt) || 0 }));
}

// ---- Usage ----

export interface UsageWindow { label: string; usedPercent: number; resetsAt?: string | null; detail?: string | null }
/** usage.limits: one provider's windows (agent_usage.rs `Usage`). */
export interface ProviderUsage { provider: string; status: string; windows: UsageWindow[]; plan?: string | null; message?: string | null; checkedAt: number; stale: boolean; dashboardUrl?: string | null }
export interface TokenTotals { input: number; cacheRead: number; cacheWrite: number; output: number; cost: number }
export interface TaskTokens { input: number; cacheRead: number; cacheWrite: number; output: number; firstUsed?: number | null; lastUsed?: number | null }
/** usage.get. */
export interface UsageOverview {
  providers: { id: string; name: string }[];
  ledger: { scannedAt?: number; day: Record<string, TokenTotals>; week: Record<string, TokenTotals> } | null;
  task: { sessionId: string; provider: string; limitedAt: number | null; limitedUntil: number | null; resumeAtReset: boolean; tokens: TaskTokens | null } | null;
}

export type UsageTone = 'success' | 'warning' | 'danger';
/** A window's bar colour: calm under 70%, warning to 90%, then danger. */
export const usageTone = (percent: number): UsageTone => (percent >= 90 ? 'danger' : percent >= 70 ? 'warning' : 'success');

/** 0-100, whatever the host sent. */
export const clampPercent = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0);

/** A reset time as a millisecond timestamp: ISO strings, seconds or milliseconds. */
export function resetTime(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(value)) {
    const n = Number(value);
    return n < 1e12 ? n * 1000 : n;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** `Resets in 2h 14m`, `Resets in 3d 4h`, `Resets now`. */
export function resetLabel(at: number | null, now: number): string {
  if (at === null) return '';
  const left = at - now;
  if (left <= 60_000) return 'Resets now';
  const minutes = Math.floor(left / 60_000);
  const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), mins = minutes % 60;
  if (days) return `Resets in ${days}d${hours ? ` ${hours}h` : ''}`;
  if (hours) return `Resets in ${hours}h${mins ? ` ${mins}m` : ''}`;
  return `Resets in ${mins}m`;
}

/** 950, 12.3K, 4.5M, 1.2B. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return String(Math.max(0, Math.round(n || 0)));
  const [value, unit] = n >= 1e9 ? [n / 1e9, 'B'] : n >= 1e6 ? [n / 1e6, 'M'] : [n / 1e3, 'K'];
  return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')}${unit}`;
}

/** $0.42, $12, <$0.01. */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2).replace(/\.00$/, '')}`;
}

export const totalTokens = (t: Pick<TokenTotals, 'input' | 'cacheRead' | 'cacheWrite' | 'output'> | null | undefined) =>
  t ? t.input + t.cacheRead + t.cacheWrite + t.output : 0;

/** The most used window first, so the card leads with what limits the agent soonest. */
export const sortedWindows = (windows: readonly UsageWindow[]) => [...windows].sort((a, b) => clampPercent(b.usedPercent) - clampPercent(a.usedPercent));
