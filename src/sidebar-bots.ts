import './sidebar-bots.css';
import type { Bot } from './bots';
import { escape, icon } from './dom';
import { resetLabel } from './usage-limit';
import { botAvatarHtml } from './bot-avatars';
import { channelFaceCluster, type SharedChannelSummary } from './bot-shared-channels';

/* The sidebar's Bots view: a bar at the bottom of the sidebar switches the whole sidebar
 * between tasks and a list of bots, each with its avatar, latest message and time. */

export type SidebarView = 'tasks' | 'bots';
/** What is going on with a bot's conversations right now, gathered by main.ts. */
export type BotSignals = { waiting?: 'approval' | 'question'; failed?: boolean; limited?: { until: number | null }; working: boolean; unread: number; responded: boolean };
export type BotStatus =
  | { kind: 'waiting'; reason: 'approval' | 'question' } | { kind: 'failed' } | { kind: 'limited'; until: number | null }
  | { kind: 'working' } | { kind: 'unread'; count: number } | { kind: 'responded' };
export type BotsListContext = { bots: Bot[]; channels?: SharedChannelSummary[]; selectedProject: string | undefined; selectedChannel?: string; signals: (bot: Bot) => BotSignals; loaded: boolean; hiddenOpen: boolean };

const VIEW_KEY = 'pandacode.sidebarView';
const SEEN_KEY = 'pandacode.botsSeen';
const PINS_KEY = 'pandacode.botsPinned';
const ORDER_KEY = 'pandacode.botsOrder';

export function storedSidebarView(): SidebarView {
  try { return localStorage.getItem(VIEW_KEY) === 'bots' ? 'bots' : 'tasks'; } catch { return 'tasks'; }
}
export function storeSidebarView(view: SidebarView): void {
  try { localStorage.setItem(VIEW_KEY, view); } catch { /* The view still switches for this session. */ }
}

function readSeen(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, number> : {};
  } catch { return {}; }
}
function writeSeen(seen: Record<string, number>): void {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* Unread marks reset next launch. */ }
}

/** A reply is unread until its conversation is opened. The first time a bot is seen, its
 *  history counts as read, so an upgrade or a new device does not light up every bot.
 *  `replies` lists when each of the bot's conversations last answered; the count is how many
 *  answered since the bot was last opened. */
export function syncSeen(bots: Bot[], openProject: string | undefined, replies: (bot: Bot) => number[] = () => []): Map<string, number> {
  const seen = readSeen(), unread = new Map<string, number>();
  let changed = false;
  for (const bot of bots) {
    const times = replies(bot), latest = Math.max(bot.lastMessage?.at ?? 0, ...times);
    if (!(bot.id in seen) || bot.projectId === openProject) {
      if (seen[bot.id] !== latest) { seen[bot.id] = latest; changed = true; }
      continue;
    }
    const count = times.filter(at => at > seen[bot.id]).length || (bot.lastMessage?.role === 'assistant' && bot.lastMessage.at > seen[bot.id] ? 1 : 0);
    if (count) unread.set(bot.id, count);
  }
  if (changed) writeSeen(seen);
  return unread;
}
export function markAllBotsRead(bots: Bot[], replies: (bot: Bot) => number[] = () => []): void {
  const seen = readSeen();
  for (const bot of bots) seen[bot.id] = Math.max(bot.lastMessage?.at ?? 0, ...replies(bot));
  writeSeen(seen);
}

function readIds(key: string): string[] {
  try { const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]'); return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []; } catch { return []; }
}
function writeIds(key: string, ids: string[]): void {
  try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* Pins and order hold for this session. */ }
}
/** Pins and the dragged order are this device's view of the list, so they live in localStorage. */
export function pinnedBots(): Set<string> { return new Set(readIds(PINS_KEY)); }
export function setBotPinned(id: string, pinned: boolean): void {
  writeIds(PINS_KEY, [...readIds(PINS_KEY).filter(item => item !== id), ...pinned ? [id] : []]);
}
/** Moves `id` just before `before` (or to the end) in the saved order, starting from what is shown. */
export function moveBot(shown: string[], id: string, before: string | null): void {
  const rest = shown.filter(item => item !== id), at = before ? rest.indexOf(before) : -1;
  writeIds(ORDER_KEY, at < 0 ? [...rest, id] : [...rest.slice(0, at), id, ...rest.slice(at)]);
}

/** The one mark a row shows. Waiting for the user outranks everything, since nothing moves until
 *  they act; a usage limit next, then work in progress, then unread replies, then a finished run. */
export function botStatus(signals: BotSignals): BotStatus | undefined {
  if (signals.waiting) return { kind: 'waiting', reason: signals.waiting };
  if (signals.failed) return { kind: 'failed' };
  if (signals.limited) return { kind: 'limited', until: signals.limited.until };
  if (signals.working) return { kind: 'working' };
  if (signals.unread > 0) return { kind: 'unread', count: signals.unread };
  return signals.responded ? { kind: 'responded' } : undefined;
}

/** Today shows the time; this week the weekday; older, the date. */
export function messageTime(at: number, now = Date.now()): string {
  const date = new Date(at), today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at >= startOfToday) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (at >= startOfToday - 86_400_000) return 'Yesterday';
  if (at >= startOfToday - 6 * 86_400_000) return date.toLocaleDateString(undefined, { weekday: 'long' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function botsBarHtml(view: SidebarView, count: number, unread: number): string {
  const open = view === 'bots';
  return `<button type="button" class="sidebar-bots-bar" data-action="toggle-bots-view" aria-pressed="${open}" title="${open ? 'Back to tasks' : 'Show bots'}">${icon('bot')}<span>Bots</span>${unread ? `<span class="sidebar-bots-unread" aria-label="${unread} unread"></span>` : ''}<small>${count || ''}</small>${icon('chevron')}</button>`;
}

export function botsPanelHeadHtml(): string {
  return `<div class="bots-panel-head"><label class="bots-panel-search">${icon('search')}<input type="search" data-bots-search placeholder="Search" aria-label="Search bots and channels" autocomplete="off" spellcheck="false"></label><button type="button" class="bots-mark-read" data-action="mark-bots-read" hidden>Mark all read</button><button type="button" class="icon-button" data-action="new-bot-menu" aria-label="Add bot or channel" title="New bot or channel" aria-haspopup="menu" aria-expanded="false" aria-controls="bot-create-menu">${icon('plus')}</button><div id="bot-create-menu" class="bot-create-menu" role="menu" aria-label="Create" hidden><button type="button" role="menuitem" data-action="new-bot">${icon('bot')}New bot</button><button type="button" role="menuitem" data-action="new-channel">${icon('chat')}New channel</button></div></div><div class="bots-panel-list"></div><span class="sr-only" id="bots-reorder-live" aria-live="polite"></span>`;
}

const CLOCK = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';
/** Short job titles ride beside the name; a sentence-long role stays in settings. */
const ROLE_TAG = 16;
const SKELETON_ROWS = 3;

function statusLabel(status: BotStatus): string {
  switch (status.kind) {
    case 'waiting': return status.reason === 'question' ? 'Needs your answer' : 'Needs approval';
    case 'failed': return 'Last turn failed';
    case 'limited': return `Usage limit · ${resetLabel(status.until)}`;
    case 'working': return 'Working';
    case 'unread': return `${status.count} unread`;
    case 'responded': return 'Responded';
  }
}

function badgeHtml(status: BotStatus | undefined): string {
  if (!status) return '';
  const inner = status.kind === 'waiting' ? '!' : status.kind === 'failed' ? icon('alert') : status.kind === 'limited' ? CLOCK : status.kind === 'working' ? '<i></i><i></i><i></i>'
    : status.kind === 'unread' ? String(Math.min(status.count, 99)) : icon('check');
  return `<span class="bot-badge ${status.kind}" role="img" aria-label="${escape(statusLabel(status))}" title="${escape(statusLabel(status))}">${inner}</span>`;
}

/** Waiting and limited bots replace the time with what is needed or when the limit resets. */
function metaHtml(bot: Bot, status: BotStatus | undefined): string {
  if (status?.kind === 'waiting') return `<span class="bot-chip waiting">${status.reason === 'question' ? 'Answer' : 'Review'}</span>`;
  // Only the time fits a narrow sidebar; the full label is the tooltip and the badge's name.
  if (status?.kind === 'limited') return `<span class="bot-chip limited" title="${escape(`Usage limit · ${resetLabel(status.until)}`)}">${CLOCK}${escape(status.until ? resetLabel(status.until).replace(/^Resets /, '') : 'Limit')}</span>`;
  return bot.lastMessage ? `<time>${escape(messageTime(bot.lastMessage.at))}</time>` : '';
}

function rowHtml(bot: Bot, context: BotsListContext, pinned: boolean, group: 'needs-you' | 'pinned' | 'bots' | 'hidden'): string {
  const selected = context.selectedProject === bot.projectId, status = botStatus(context.signals(bot)), message = bot.lastMessage;
  const preview = bot.paused ? `Paused since ${new Date(bot.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
    : message ? `${message.role === 'user' ? 'You: ' : ''}${message.text}` : bot.role || 'No messages yet';
  // The tag only rides beside the name when no time or chip competes for the line.
  const meta = metaHtml(bot, status);
  const role = bot.role && bot.role !== preview && !meta && [...bot.role].length <= ROLE_TAG ? `<span class="bot-role-tag">${escape(bot.role)}</span>` : '';
  const state = [bot.paused ? 'paused' : '', status ? statusLabel(status) : ''].filter(Boolean).join(', ');
  return `<div class="bot-row bot-card${selected ? ' selected' : ''}${bot.paused ? ' paused' : ''}${pinned ? ' pinned' : ''}" role="listitem" draggable="${group === 'pinned' || group === 'bots'}" data-bot-group="${group}" data-bot-row="${escape(bot.id)}">
      <button type="button" class="bot-row-open" data-action="open-bot" data-bot="${escape(bot.id)}" aria-label="Chat with ${escape(bot.name)}${state ? ` (${escape(state)})` : ''}" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" title="Chat with ${escape(bot.name)}; Alt+Arrow keys reorder within this group" ${selected ? 'aria-current="page"' : ''}>
        <span class="bot-card-avatar">${botAvatarHtml(bot.avatar, bot.name, 'bot-card-face', bot.color)}${badgeHtml(status)}</span>
        <span class="bot-card-text"><span class="bot-card-head"><span class="bot-row-name">${escape(bot.name)}</span>${role}${meta}</span><span class="bot-card-preview">${escape(preview)}</span></span>
      </button>
      <button type="button" class="icon-button bot-row-settings" data-action="bot-settings" data-bot="${escape(bot.id)}" aria-label="${escape(bot.name)} settings" title="Settings, memory, schedules and channels">${icon('settings')}</button>
    </div>`;
}

function groupHtml(label: string, rows: string, showLabel: boolean, name = label): string {
  return `<div class="bots-group" role="group" aria-label="${escape(name)}">${showLabel ? `<h3 class="bots-group-label" aria-hidden="true">${escape(label)}</h3>` : ''}<div role="list">${rows}</div></div>`;
}

/** Saved order first (bots never dragged come before, newest first), otherwise most recent first. */
export function ordered(bots: Bot[]): Bot[] {
  const order = readIds(ORDER_KEY), recent = (bot: Bot) => bot.lastMessage?.at ?? bot.updatedAt;
  return [...bots].sort((a, b) => {
    const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
    if (ai < 0 && bi >= 0) return 1;
    if (bi < 0 && ai >= 0) return -1;
    return ai >= 0 && bi >= 0 ? ai - bi : recent(b) - recent(a);
  });
}

export function botsListHtml(context: BotsListContext, query: string): string {
  const channels = context.channels ?? [];
  if (!context.loaded) return `<div class="bots-skeleton" role="status" aria-label="Loading bots">${'<span class="bot-row-skeleton" aria-hidden="true"><i></i><span><i></i><i></i></span></span>'.repeat(SKELETON_ROWS)}</div>`;
  const needle = query.trim().toLowerCase();
  const bots = ordered(context.bots.filter(bot => !needle || `${bot.name} ${bot.role} ${bot.lastMessage?.text ?? ''}`.toLowerCase().includes(needle)));
  const matchingChannels = channels.filter(channel => !needle || channel.name.toLowerCase().includes(needle));
  const pins = pinnedBots();
  const waiting = bots.filter(bot => !bot.paused && context.signals(bot).waiting);
  const pinned = bots.filter(bot => !bot.paused && pins.has(bot.id) && !waiting.includes(bot));
  const rest = bots.filter(bot => !bot.paused && !pins.has(bot.id) && !waiting.includes(bot));
  const hidden = bots.filter(bot => bot.paused);
  const rows = (list: Bot[], group: 'needs-you' | 'pinned' | 'bots' | 'hidden') => list.map(bot => rowHtml(bot, context, pins.has(bot.id), group)).join('');
  const labelled = Boolean(waiting.length || pinned.length);
  // The open bot stays in view even after it is paused.
  const hiddenOpen = context.hiddenOpen || hidden.some(bot => bot.projectId === context.selectedProject);
  const botGroups = (waiting.length ? groupHtml('Needs you', rows(waiting, 'needs-you'), true) : '')
    + (pinned.length ? groupHtml('Pinned', rows(pinned, 'pinned'), true) : '')
    + (rest.length ? groupHtml('Bots', rows(rest, 'bots'), labelled, 'Other bots') : '')
    + (hidden.length ? `<div class="bots-group bots-hidden" role="group" aria-label="Hidden"><button type="button" class="bots-group-label bots-group-toggle" data-action="toggle-hidden-bots" aria-expanded="${hiddenOpen}">${icon('chevron')}<span>Hidden (${hidden.length})</span></button>${hiddenOpen ? `<div role="list">${rows(hidden, 'hidden')}</div>` : ''}</div>` : '');
  const activeChannels = matchingChannels.filter(channel => !channel.archived);
  const deletedChannels = matchingChannels.filter(channel => channel.archived);
  const channelRows = (items: SharedChannelSummary[]) => items.map(channel => `<button type="button" class="channel-row${context.selectedChannel === channel.id ? ' selected' : ''}"${context.selectedChannel === channel.id ? ' aria-current="page"' : ''} data-action="open-shared-channel" data-channel="${escape(channel.id)}" aria-label="#${escape(channel.name)}">${channelFaceCluster(channel.memberIds, context.bots)}<span>#${escape(channel.name)}</span></button>`).join('');
  const channelGroups = (activeChannels.length ? `<div class="bots-group bots-group-channels" role="group" aria-label="Channels"><h3 class="bots-group-label">Channels</h3><div role="list">${channelRows(activeChannels)}</div></div>` : '')
    + (deletedChannels.length ? `<div class="bots-group bots-hidden" role="group" aria-label="Deleted channels"><h3 class="bots-group-label">Deleted channels</h3><div role="list">${channelRows(deletedChannels)}</div></div>` : '');
  const empty = !bots.length && !channels.length ? `<div class="bots-panel-start"><p>No bots yet</p><button type="button" class="secondary-button" data-action="new-bot-menu">${icon('plus')}<span>Create your first bot or channel</span></button></div>` : '';
  const noMatch = Boolean((context.bots.length || channels.length) && !bots.length && !matchingChannels.length) ? '<p class="bots-panel-empty">No bots or channels match.</p>' : '';
  return `${empty}${botGroups}${channelGroups}${noMatch}`;
}
