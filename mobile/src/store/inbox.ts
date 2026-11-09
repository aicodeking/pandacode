// The inbox: every computer's tasks in one list, grouped by what they need from you.
// Pure (tested in node): screens pass store slices in and render the result.
import type { Bot, PendingRequest, TaskSummary, TasksList } from '../connect/types.ts';
import type { Live } from './reduce.ts';
import { decodeTeamRun, teamBusy, teamRun, waitingOn, type Team, type TeamRun } from './team.ts';
import { describeTool, subagentActive, traceText } from './trace.ts';

export const SETTLED_MS = 24 * 3600_000;
/** A running task with no event for this long shows as stalled. */
export const STALL_MS = 120_000;

export type Section = 'running' | 'needs' | 'recent' | 'unsent' | 'snoozed' | 'settled';
export type Badge = 'approval' | 'question' | 'working' | 'failed' | 'stopped' | 'limited' | 'unsent' | null;

/** What a running row shows: its current activity, active subagents, and the times its clock reads. */
export interface RunGlance {
  /** The current tool (`Running npm test`), `Thinking`, or the status line. */
  activity: string;
  agents: number;
  startedAt?: number;
  lastEventAt?: number;
  /** An account limit's reset time (null: unknown), while it lasts. */
  limitedUntil?: number | null;
}

export interface InboxRow {
  /** taskKey */
  key: string;
  deviceId: string;
  computer: string;
  task: TaskSummary;
  badge: Badge;
  run: RunGlance;
  /** Sort time: the last prompt or update. */
  at: number;
  pinned: boolean;
  /** Outbox entry id and message text for Unsent rows. */
  outboxId?: string;
  text?: string;
}

export interface OutboxEntry { id: string; deviceId: string; sessionId: string; text: string; createdAt: number; error?: string }

export interface InboxInput {
  hosts: readonly { id: string; name: string }[];
  tasks: Readonly<Record<string, TasksList | undefined>>;
  live: Readonly<Record<string, Live | undefined>>;
  /** taskKey → snoozed until (ms). */
  snoozed: Readonly<Record<string, number>>;
  /** taskKey → pinned on this phone. */
  pins: Readonly<Record<string, boolean>>;
  outbox: readonly OutboxEntry[];
  now: number;
  /** Precomputed glanceOf per taskKey (useInbox keeps them out of per-delta work); computed from `live` when absent. */
  glances?: Readonly<Record<string, RunGlance | undefined>>;
  /** Loaded task.team per taskKey (store `teams`), for older hosts whose rows carry no `team`. */
  teams?: Readonly<Record<string, Team | null | 'outdated' | undefined>>;
}

export type Inbox = Record<Section, InboxRow[]>;

const CURRENT_TOOL_MAX = 80;

/** The task's team: the row's own (newer hosts), else the loaded task.team (older hosts). */
export const rowTeam = (task: TaskSummary | undefined, loaded?: Team | null | 'outdated'): TeamRun | undefined =>
  (task?.team !== undefined ? decodeTeamRun(task.team) : teamRun(loaded));

/** The run's activity line, as the desktop's working row: a running tool's sentence, else thinking,
 * else a subagent's running tool, else the status, else what a busy team leaves it waiting on. */
export function glanceOf(live: Live | undefined, task?: TaskSummary, team: TeamRun | undefined = rowTeam(task)): RunGlance {
  const subagents = live?.subagents ?? [];
  const agents = subagents.filter(subagentActive).length;
  const tool = live?.items.findLast(i => i.kind === 'tool' && i.tool.status === 'running');
  const runningChild = subagents.findLast(a => subagentActive(a) && a.tools.some(t => t.status === 'running'));
  const childTool = runningChild?.tools.findLast(t => t.status === 'running');
  const sentence = (t: { name: string; status: 'running' | 'completed' | 'failed'; input: string }) => {
    return traceText(describeTool(t)).slice(0, CURRENT_TOOL_MAX);
  };
  const activity = tool?.kind === 'tool' ? sentence(tool.tool)
    : live?.thinking ? 'Thinking'
    : childTool ? sentence(childTool)
    : live?.activity && live.activity !== 'Working…' ? live.activity
    : teamBusy(team) && (!live || live.status === 'idle' || live.held) ? waitingOn(team!.activeWorkers) : '';
  const limitedUntil = live?.limited ? live.limited.resetsAt : undefined;
  return { activity, agents, startedAt: live?.startedAt ?? task?.runStartedAt ?? undefined, lastEventAt: live?.lastEventAt ?? task?.lastEventAt ?? undefined, limitedUntil };
}

/** When the run started, the one clock the inbox row and the thread's Working pill both read. A
 * steer or follow-up prompt during a run doesn't restart it; older hosts only give the last prompt. */
export function runClockStart(live: Pick<Live, 'startedAt'> | undefined, task: Pick<TaskSummary, 'runStartedAt' | 'lastPromptAt'> | undefined): number | undefined {
  return live?.startedAt ?? task?.runStartedAt ?? task?.lastPromptAt ?? undefined;
}

type SignatureList = { tasks: readonly TaskSummary[] } | undefined;
const signatures = new WeakMap<Live, { key: string; list: SignatureList; entry: string }>();

/** One live run as useInbox's signature sees it; recomputed only when that Live or its host's list changes. */
function signatureEntry(key: string, live: Live, list: SignatureList): string {
  const hit = signatures.get(live);
  if (hit && hit.key === key && hit.list === list) return hit.entry;
  const sessionId = key.slice(key.indexOf('/') + 1);
  const { lastEventAt: _, ...glance } = glanceOf(live, list?.tasks.find(t => t.sessionId === sessionId));
  const entry = JSON.stringify([key, live.status, live.approvals.length, live.inputs.length, live.limited ?? null, glance]);
  signatures.set(live, { key, list, entry });
  return entry;
}

/**
 * Only what the inbox shows from each live run (status, request counts, limit and its glance:
 * current tool, thinking, subagents), as one string, so streamed text deltas don't recompute the
 * list. lastEventAt is left out: each row's clock reads it when it ticks. Runs on every store update.
 */
export function liveSignature(live: Readonly<Record<string, Live>>, tasks: Readonly<Record<string, SignatureList>>): string {
  return `[${Object.entries(live).map(([key, l]) => signatureEntry(key, l, tasks[key.slice(0, key.indexOf('/'))])).join(',')}]`;
}

/** How long a running task has been silent, if that is longer than STALL_MS (else null). Unknown times never stall. */
export function stalledFor(lastEventAt: number | null | undefined, now: number): number | null {
  if (!lastEventAt) return null;
  const quiet = now - lastEventAt;
  return quiet > STALL_MS ? quiet : null;
}

/** `team`: the task's team (rowTeam); `agents`: its active subagents. Either keeps it working. */
function badgeOf(task: TaskSummary, live: Live | undefined, now: number, team?: TeamRun, agents = 0): Badge {
  const approvals = live?.approvals.length ?? task.pending?.filter(p => p.kind === 'approval').length ?? 0;
  const inputs = live?.inputs.length ?? task.pending?.filter(p => p.kind === 'input_request').length ?? 0;
  if (approvals) return 'approval';
  if (inputs) return 'question';
  // A live view that went idle (run.finished) is newer than the last list.
  const status = live && live.status !== 'idle' ? live.status : task.status;
  if (status === 'waiting') return 'approval';
  if (status === 'running' || teamBusy(team) || agents > 0) return 'working';
  if (live?.limited && (live.limited.resetsAt == null || live.limited.resetsAt > now)) return 'limited';
  if (status === 'failed') return 'failed';
  if (status === 'stopped') return 'stopped';
  return null;
}

const byTime = (a: InboxRow, b: InboxRow) => Number(b.pinned) - Number(a.pinned) || b.at - a.at;
const waitingOnYou = (row: InboxRow) => row.badge === 'approval' || row.badge === 'question';
/** Needs you: approvals and questions first, then failures and limits. */
const byNeed = (a: InboxRow, b: InboxRow) => Number(waitingOnYou(b)) - Number(waitingOnYou(a)) || byTime(a, b);

export function inboxSections({ hosts, tasks, live, snoozed, pins, outbox, now, glances, teams }: InboxInput): Inbox {
  const out: Inbox = { running: [], needs: [], recent: [], unsent: [], snoozed: [], settled: [] };
  const index = new Map<string, InboxRow>();
  for (const host of hosts) {
    for (const task of tasks[host.id]?.tasks ?? []) {
      if (task.botId) continue; // under Bots (botRows)
      const key = `${host.id}/${task.sessionId}`;
      const team = rowTeam(task, teams?.[key]);
      const run = glances?.[key] ?? glanceOf(live[key], task, team);
      const badge = badgeOf(task, live[key], now, team, run.agents);
      const at = Math.max(task.lastPromptAt ?? 0, task.updatedAt);
      const row: InboxRow = { key, deviceId: host.id, computer: host.name, task, badge, run, at, pinned: !!pins[key] || task.pinned };
      index.set(key, row);
      const old = !row.pinned && now - at > SETTLED_MS;
      if ((snoozed[key] ?? 0) > now) out.snoozed.push(row);
      else if (badge === 'working') out.running.push(row);
      else if (waitingOnYou(row) || (!old && (badge === 'failed' || badge === 'limited'))) out.needs.push(row);
      else if (old) out.settled.push(row);
      else out.recent.push(row);
    }
  }
  for (const entry of outbox) {
    const row = index.get(`${entry.deviceId}/${entry.sessionId}`);
    if (row) out.unsent.push({ ...row, key: `outbox/${entry.id}`, badge: 'unsent', at: entry.createdAt, outboxId: entry.id, text: entry.text });
  }
  for (const section of Object.keys(out) as Section[]) if (section !== 'unsent') out[section].sort(section === 'needs' ? byNeed : byTime);
  return out;
}

/** Drops snoozes that have ended, so the stored map doesn't grow. */
export const activeSnoozes = (snoozed: Readonly<Record<string, number>>, now: number) =>
  Object.fromEntries(Object.entries(snoozed).filter(([, until]) => until > now));

/** Tomorrow at 8:00 local time. */
export function tomorrowMorning(now: number): number {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.getTime();
}

/** How long a row has been working or waiting, for the Duo sidebar: `<1m`, `6m`, `1h 5m`, `3d`. */
export function elapsedLabel(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Rows whose title, project, branch or computer contains `query` (case-insensitive). */
export function filterRows(rows: readonly InboxRow[], query: string): InboxRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter(r => [r.task.title, r.task.chat ? 'Chat' : r.task.projectName, r.task.branch, r.computer].some(v => v?.toLowerCase().includes(q)));
}

/** A bot in the inbox's Bots section: `at` is its conversations' latest activity (0 if none listed). */
export interface BotRow { key: string; deviceId: string; computer: string; bot: Bot; at: number }

/** Every computer's bots, most recently active first, then by name. */
export function botRows(hosts: readonly { id: string; name: string }[], bots: Readonly<Record<string, readonly Bot[] | undefined>>, tasks: InboxInput['tasks']): BotRow[] {
  const rows: BotRow[] = [];
  for (const host of hosts) {
    const latest = new Map<string, number>();
    for (const t of tasks[host.id]?.tasks ?? []) if (t.botId) latest.set(t.botId, Math.max(latest.get(t.botId) ?? 0, t.lastPromptAt ?? 0, t.updatedAt));
    for (const bot of bots[host.id] ?? []) rows.push({ key: `${host.id}/bot/${bot.id}`, deviceId: host.id, computer: host.name, bot, at: latest.get(bot.id) ?? 0 });
  }
  return rows.sort((a, b) => b.at - a.at || a.bot.name.localeCompare(b.bot.name));
}

/** The bot whose conversation this task is: its listed botId, or the bot's desktop conversation. */
export function botOf(bots: readonly Bot[] | undefined, task: Pick<TaskSummary, 'botId'> | undefined, sessionId: string): Bot | undefined {
  return bots?.find(b => b.id === task?.botId || b.desktopSession === sessionId);
}

/** Bot rows whose name or computer contains `query`. */
export function filterBots(rows: readonly BotRow[], query: string): BotRow[] {
  const q = query.trim().toLowerCase();
  return q ? rows.filter(r => [r.bot.name, r.computer].some(v => v.toLowerCase().includes(q))) : [...rows];
}

/** Rows and bots on one computer that also match the search. Returns the inputs when nothing filters. */
export function filterInbox(inbox: Inbox, bots: readonly BotRow[], { query = '', computer }: { query?: string; computer?: string }): { inbox: Inbox; bots: readonly BotRow[] } {
  if (!query.trim() && !computer) return { inbox, bots };
  const here = <T extends { deviceId: string }>(rows: T[]) => (computer ? rows.filter(r => r.deviceId === computer) : rows);
  const filtered = Object.fromEntries((Object.keys(inbox) as Section[]).map(section => [section, here(filterRows(inbox[section], query))])) as Inbox;
  return { inbox: filtered, bots: here(filterBots(bots, query)) };
}

export type SectionId = Section | 'bots';
const ORDER: readonly SectionId[] = ['running', 'needs', 'recent', 'unsent', 'bots', 'snoozed', 'settled'];
const FOLDED: ReadonlySet<SectionId> = new Set(['snoozed', 'settled']);

/** A list item is one slice of a section's card (`first`/`last` in its inner card), so the list stays
 * virtualised. Keys don't name the section, so a row changing sections travels as the same cell.
 * `open`: undefined when the section doesn't fold. `computer`: the one computer all its rows are on, said once on the head. */
export type InboxItem =
  | { type: 'head'; key: string; section: SectionId; count: number; open?: boolean; computer?: string }
  | { type: 'row'; key: string; section: Section; row: InboxRow; first: boolean; last: boolean; position: number; showComputer: boolean }
  | { type: 'bot'; key: string; row: BotRow; first: boolean; last: boolean; position: number; showComputer: boolean };

/** The flat list for the inbox and the sidebar. `open`: which folded sections show their rows, or 'all' (nothing folds). */
export function inboxItems(inbox: Inbox, bots: readonly BotRow[], open: Partial<Record<SectionId, boolean>> | 'all'): InboxItem[] {
  const listed = new Set([...bots, ...Object.values(inbox).flat()].map(r => r.deviceId));
  return ORDER.flatMap((section): InboxItem[] => {
    const rows = section === 'bots' ? bots : inbox[section];
    if (!rows.length) return [];
    const folds = open !== 'all' && FOLDED.has(section);
    const shown = !folds || !!open[section];
    const oneHere = new Set(rows.map(r => r.deviceId)).size === 1;
    const computer = listed.size > 1 && oneHere ? rows[0].computer : undefined;
    const head: InboxItem = { type: 'head', key: `h/${section}`, section, count: rows.length, open: folds ? shown : undefined, computer };
    if (!shown) return [head];
    const shared = (i: number) => ({ position: i, first: i === 0, last: i === rows.length - 1, showComputer: listed.size > 1 && !oneHere });
    return [head, ...(section === 'bots'
      ? bots.map((row, i): InboxItem => ({ type: 'bot', key: row.key, row, ...shared(i) }))
      : inbox[section].map((row, i): InboxItem => ({ type: 'row', key: row.key, section, row, ...shared(i) })))];
  });
}

/** What the tab and app icon badges count: everything under Needs you (snoozed rows have left it). */
export const needsYouCount = (inbox: Pick<Inbox, 'needs'>) => inbox.needs.length;

/** The approval a row is waiting on: from the live run, else as last listed. Undefined until the request is loaded. */
export function pendingApproval(live: Pick<Live, 'approvals'> | undefined, task: Pick<TaskSummary, 'pending'>): PendingRequest | undefined {
  return live?.approvals.find(p => p?.requestId) ?? task.pending?.find(p => p.kind === 'approval' && p.requestId);
}

const CONFIRM_MAX = 400;

/** What a confirm alert shows before approving: the agent's words and the command, cut to fit an alert. */
export function approvalSummary(request: Pick<PendingRequest, 'text' | 'tool'>): string {
  const command = request.tool ? [request.tool.name, request.tool.input].filter(Boolean).join('\n') : '';
  // An alert can't draw the agent's Markdown, so its emphasis and code marks go.
  const words = request.text.replace(/\*\*|`/g, '');
  const full = [words, command].filter(Boolean).join('\n\n') || 'The agent asks to continue.';
  return full.length > CONFIRM_MAX ? `${full.slice(0, CONFIRM_MAX)}…` : full;
}

/** Tasks restored from the cache are waiting for a live list that can actually come: only while connected, from an online host. */
export function stillUpdating(tasks: Readonly<Record<string, { cachedAt?: number } | undefined>>, devices: readonly { id: string; online: boolean; host: boolean }[], connected: boolean): boolean {
  return connected && Object.entries(tasks).some(([id, list]) => list?.cachedAt !== undefined && devices.some(d => d.id === id && d.online && d.host));
}

/** Nothing can be said about an empty inbox yet: presence hasn't arrived (it lists this phone too), or an online host's first list hasn't. */
export function inboxLoading(deviceCount: number, hosts: readonly { id: string; online: boolean }[], tasks: InboxInput['tasks'], errors: Readonly<Record<string, unknown>>): boolean {
  return !deviceCount || hosts.some(h => h.online && !tasks[h.id] && !errors[h.id]);
}

export interface ListError { message: string; at: number }

/** Load errors worth showing, naming the computer: gone once it is offline or a newer list arrived. */
export function listProblems(errors: Readonly<Record<string, ListError>>, hosts: readonly { id: string; name: string; online: boolean }[], tasks: Readonly<Record<string, { loadedAt: number } | undefined>>): string[] {
  return hosts.flatMap(h => {
    const error = errors[h.id];
    return error && h.online && (tasks[h.id]?.loadedAt ?? 0) < error.at ? [`${h.name}: ${error.message}`] : [];
  });
}

/** What an empty, loaded inbox or sidebar says. */
export function emptyCopy(hosts: readonly { id: string; name: string; online: boolean }[], { query, computer }: { query?: string; computer?: string }): { title: string; body?: string } {
  if (query?.trim()) return { title: 'No matching tasks' };
  const named = computer ? hosts.find(h => h.id === computer)?.name : undefined;
  if (computer) return { title: `No tasks on ${named ?? 'this computer'}` };
  if (!hosts.length) return { title: 'No computers yet', body: 'Turn on remote access on a computer signed in to the same GitHub account to see its tasks here.' };
  if (!hosts.some(h => h.online)) {
    const names = hosts.map(h => h.name);
    return { title: `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} offline` };
  }
  return { title: 'No tasks yet', body: 'Start one with New task.' };
}

const META_CHAR = 6.6;
const CODE_CHAR = 7.9;
const CHIP_PADDING = 16;
const META_GAP = 7;
const ICON_WIDTH = 17;

/**
 * Whether a branch chip fits a row's meta line next to its status, project and computer without
 * being squeezed to `fea…ys`; without room the branch stays in the task itself and VoiceOver's label.
 * ponytail: estimated from character counts, measure with onTextLayout if chips get dropped too eagerly.
 */
export function branchFits(parts: { status: string; statusIcon: boolean; branch: string; project: string; computer?: string }, width: number, fontScale = 1): boolean {
  const { status, statusIcon, branch, project, computer } = parts;
  const text = (status.length + project.length + (computer?.length ?? 0)) * META_CHAR + branch.length * CODE_CHAR;
  const fixed = CHIP_PADDING + (statusIcon ? ICON_WIDTH : 0) + META_GAP * (computer ? 3 : 2);
  return text * fontScale + fixed <= width;
}

const PLATFORM_NAMES: Readonly<Record<string, string>> = { macos: 'macOS', darwin: 'macOS', windows: 'Windows', win32: 'Windows', linux: 'Linux', ios: 'iOS', android: 'Android' };
export const platformName = (platform: string) => PLATFORM_NAMES[platform.toLowerCase()] ?? platform;

/** The Computers card's task count: what's running and waiting, else how many tasks it lists. */
export function computerSummary(inbox: Inbox, deviceId: string): string {
  const count = (section: Section) => inbox[section].filter(r => r.deviceId === deviceId).length;
  const parts = [count('running') && `${count('running')} running`, count('needs') && `${count('needs')} need${count('needs') === 1 ? 's' : ''} you`].filter(Boolean);
  if (parts.length) return parts.join(' · ');
  const total = (['recent', 'snoozed', 'settled'] as const).reduce((sum, section) => sum + count(section), 0);
  return total ? `${total} task${total === 1 ? '' : 's'}` : '';
}
