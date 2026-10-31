/** A bot's conversation pane: chat bubbles, grouped messages, day and unread dividers, hover
 *  actions (copy, reply, react), the working indicator and a steps row per finished turn.
 *  Only bot threads (`.bot-thread`) use it; the transcript itself is built by main.ts. */
import { failoverCardHtml, modelSwitchMarkerHtml, type Activity, type Bot, type FailoverAsk } from './bots';
import { botAvatarHtml } from './bot-avatars';
import { escape, icon } from './dom';
import { formatDuration } from './turn-activity';

type SavedMessage = { id: number; role: string; content: string; createdAt: number };
export type BotMessageMarker = { id: string; kind: 'sent' | 'received' | 'update'; botId: string; botName: string; avatar: string; color: string; text: string; result: string | null; status: string; createdAt: number };
/** The live run, as main.ts keeps it. */
export type BotRun = { startedAt: number; status: string; text: string; revision: number; approvals: Map<string, unknown>; inputs: Map<string, unknown> };
export type ModelChoice = { provider: string; model: string; label: string };

const GROUP_MS = 5 * 60_000;
const STALL_MS = 20_000;
const ELAPSED_AFTER_MS = 5_000;
const NEAR_BOTTOM_PX = 80;
const REACTIONS = ['👍', '❤️', '😂', '🎉', '🤔', '👀'];
const REACTIONS_KEY = 'pandacode.botReactions', SEEN_KEY = 'pandacode.botSeen';
export const WORKING_LABELS = ['Working on it…', 'Thinking it through…', 'Connecting the dots…', 'Checking the details…', 'Putting the answer together…', 'Making sense of it…', 'One step at a time…', 'Tiny gears are turning…', 'Consulting the inner council…', 'Cooking up something useful…'];
/** Statuses that say nothing beyond "working"; anything else is progress worth showing. */
const GENERIC_STATUS = new Set(['', 'running', 'Working…', 'Starting agent', 'Continuing task', 'Generating response']);
const svg = (paths: string) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const CLOCK = svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>');
const REPLY = svg('<path d="M9 7 4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 6 6v1"/>');
const SMILE = svg('<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>');

function readJson<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? '') as T; } catch { return fallback; }
}

/** The header: the bot (a button to its settings), where the thread comes from, and compact controls. */
export function crumbHtml(bot: Bot, options: { where: string; status: string; nextModel?: { running: string; next: string } }): string {
  const id = escape(bot.id), name = escape(bot.name);
  const next = options.nextModel ? `${escape(options.nextModel.running)} finishes this turn. ${escape(options.nextModel.next)} starts with the next one.` : '';
  return `<span class="bot-crumb"><button class="bot-crumb-who" data-action="bot-settings" data-bot="${id}" aria-label="View bot settings" title="Profile, memory, schedules, channels and rules">${botAvatarHtml(bot.avatar, bot.name, 'bot-crumb-avatar', bot.color)}<strong>${name}</strong></button>`
    + `${options.where ? `<span class="bot-crumb-where">${escape(options.where)}</span>` : ''}<span class="bot-crumb-state sr-only">${escape(options.status)}</span>`
    + `${next ? `<span class="bot-next-model" tabindex="0" role="note" aria-label="${next}" title="${next}">${CLOCK}After this turn</span>` : ''}</span>`
    + `<button class="icon-button bot-crumb-action" data-action="bot-pause" data-bot="${id}" aria-label="${bot.paused ? 'Resume' : 'Pause'} ${name}" title="${bot.paused ? 'Resume: schedules, check-ins and channels continue' : 'Pause: stop work and hold schedules and messages'}" aria-pressed="${bot.paused}">${icon(bot.paused ? 'play' : 'pause')}</button>`
    + `<button class="icon-button bot-crumb-action" data-action="bot-settings" data-bot="${id}" aria-label="${name} settings" title="Settings">${icon('settings')}</button>`;
}

/** Three things to ask, matched to what the bot is for. */
export function suggestions(role: string): string[] {
  const topics: [RegExp, string[]][] = [
    [/research|scout|investigat|analy/i, ['Research the latest news on a topic I care about.', 'Compare three options and recommend one.']],
    [/writ|draft|post|blog|content|copy/i, ['Draft a short post about what I shipped this week.', 'Tighten this paragraph for me.']],
    [/financ|ledger|budget|money|expens|account/i, ['Summarize my spending categories this month.', 'Remind me of bills due this week.']],
    [/code|review|engineer|dev|bug|test/i, ['Review the latest changes for bugs.', 'Explain how this project is structured.']],
    [/support|help ?desk|customer|inbox|email/i, ['Draft a friendly reply to a customer question.', 'Sort these messages by urgency.']],
  ];
  const matched = topics.find(([pattern]) => pattern.test(role))?.[1] ?? ['Remember that I prefer short, direct answers.', 'Every weekday at 9, send me a summary of what changed.'];
  return ['What can you help me with?', ...matched];
}

/** An empty bot conversation: who it is, three things to ask, and small settings shortcuts. */
export function welcomeHtml(bot: Bot): string {
  const id = escape(bot.id);
  const setup = ([['profile', 'edit', 'Instructions'], ['memory', 'leaf', 'Memory'], ['schedules', 'refresh', 'Schedules'], ['channels', 'globe', 'Connections']] as const)
    .map(([tab, glyph, label]) => `<button data-action="bot-settings" data-bot="${id}" data-tab="${tab}">${icon(glyph)}${label}</button>`).join('');
  const chips = suggestions(`${bot.role} ${bot.name}`).map(text => `<button class="bot-suggestion" data-action="suggest" data-text="${escape(text)}">${escape(text)}</button>`).join('');
  return `<div class="new-task-welcome bot-welcome">${botAvatarHtml(bot.avatar, bot.name, 'bot-welcome-avatar', bot.color)}<h1>${escape(bot.name)} is ready.</h1><p>Ask, then watch it work.</p><div class="bot-suggestions" role="group" aria-label="Suggestions">${chips}</div><div class="bot-welcome-setup" role="group" aria-label="Set up ${escape(bot.name)}">${setup}</div></div>`;
}

/** "Today 3:04 PM", "Yesterday 9:12 AM", "Tue, Oct 6 3:04 PM". */
export function dayLabel(at: number, now = Date.now()): string {
  const date = new Date(at), today = new Date(now);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(date.toDateString()).getTime()) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}

/** Mostly code blocks or images reads better without the bubble's fill. */
export function mostlyMedia(content: string): boolean {
  const text = content.replace(/```[\s\S]*?(```|$)/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();
  return content.trim().length > 0 && text.length < content.trim().length * 0.3;
}

// ---- Per-thread state: the open thread, unread divider, jump pill, reply and reactions.
let opened = '';
let unreadAfter: number | undefined;
let knownReplies = 0, unseen = 0;
let reply: { sessionId: string; author: string; quote: string } | undefined;
const nextModels = new Map<string, ModelChoice>();
let bound: HTMLElement | undefined;

/** Called on every transcript render; a different thread resets the per-open state. */
export function noteThread(sessionId: string): void {
  if (sessionId === opened) return;
  opened = ''; unreadAfter = undefined; knownReplies = 0; unseen = 0;
  document.querySelector('.bot-jump')?.remove();
}

function reactionsFor(key: string): string[] { return readJson<Record<string, string[]>>(REACTIONS_KEY, {})[key] ?? []; }
function setReactions(key: string, list: string[]): void {
  const all = readJson<Record<string, string[]>>(REACTIONS_KEY, {});
  const { [key]: _previous, ...rest } = all;
  try { localStorage.setItem(REACTIONS_KEY, JSON.stringify(list.length ? { ...rest, [key]: list } : rest)); } catch { /* Reactions stay optional when browser storage is full. */ }
}
function reactionsHtml(key: string): string {
  const list = reactionsFor(key);
  return list.length ? `<div class="bot-reactions">${list.map(emoji => `<button type="button" class="bot-reaction" data-bot-unreact="${escape(emoji)}" aria-label="Remove your ${escape(emoji)} reaction" aria-pressed="true">${escape(emoji)}</button>`).join('')}</div>` : '';
}

const nearBottom = (transcript: HTMLElement) => transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < NEAR_BOTTOM_PX;

/** Restyles a freshly rendered bot transcript. Runs after main.ts restores the scroll position. */
export function decorateTranscript(transcript: HTMLElement, bot: Bot, sessionId: string, messages: SavedMessage[], switches: Activity[] = [], collaboration: BotMessageMarker[] = []): void {
  bind(transcript);
  const byId = new Map(messages.map(message => [String(message.id), message]));
  const seen = readJson<Record<string, number>>(SEEN_KEY, {});
  const fresh = opened !== sessionId;
  if (fresh) { opened = sessionId; unreadAfter = seen[sessionId]; }
  let previous: { user: boolean; at: number } | undefined, divided = false, replies = 0;
  for (const article of transcript.querySelectorAll<HTMLElement>(':scope > article.message[data-message-id]')) {
    const message = byId.get(article.dataset.messageId!);
    if (!message) continue;
    const user = article.classList.contains('user-message'), at = message.createdAt < 1e12 ? message.createdAt * 1000 : message.createdAt;
    if (!user && message.id > 0) replies++;
    if (!user && !divided && unreadAfter !== undefined && at > unreadAfter && message.id > 0) {
      article.insertAdjacentHTML('beforebegin', '<div class="bot-divider bot-unread" role="separator" aria-label="New messages"><span>New messages</span></div>');
      divided = true;
    }
    if (!previous || new Date(previous.at).toDateString() !== new Date(at).toDateString()) article.insertAdjacentHTML('beforebegin', `<div class="bot-divider bot-day" role="separator"><span>${escape(dayLabel(at))}</span></div>`);
    else if (previous.user === user && at - previous.at < GROUP_MS) article.classList.add('bot-grouped');
    previous = { user, at };
    if (!user) {
      article.classList.toggle('bot-plain', mostlyMedia(message.content));
      const avatar = article.querySelector('.message-avatar'), name = article.querySelector('.message-meta strong');
      if (avatar) avatar.innerHTML = botAvatarHtml(bot.avatar, bot.name, 'bot-message-avatar', bot.color);
      if (name) name.textContent = bot.name;
    }
    const actions = article.querySelector<HTMLElement>(':scope > .message-actions');
    if (actions && message.id > 0) {
      actions.insertAdjacentHTML('afterbegin', `<time class="bot-message-time" datetime="${new Date(at).toISOString()}">${escape(new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</time>`);
      actions.querySelector('.message-action-status')?.insertAdjacentHTML('beforebegin', `<button type="button" data-bot-reply aria-label="Reply" title="Reply">${REPLY}</button><button type="button" data-bot-react aria-label="React" title="React" aria-expanded="false">${SMILE}</button><span class="bot-react-menu" role="group" aria-label="Reactions" hidden>${REACTIONS.map(emoji => `<button type="button" data-bot-emoji="${emoji}" aria-label="React with ${emoji}">${emoji}</button>`).join('')}</span>`);
      article.dataset.reactionKey = `${sessionId}:${message.id}`;
      actions.insertAdjacentHTML('beforebegin', reactionsHtml(article.dataset.reactionKey));
    }
  }
  paintModelSwitches(transcript, byId, switches);
  paintBotMessages(transcript, messages, collaboration);
  decorateSteps(transcript);
  // Replies that arrive while you read further up show as a pill instead of moving the page.
  if (!fresh && replies > knownReplies && !nearBottom(transcript)) unseen += replies - knownReplies;
  if (nearBottom(transcript)) unseen = 0;
  knownReplies = replies;
  paintJump(transcript);
  const latest = messages.reduce((max, message) => Math.max(max, message.createdAt < 1e12 ? message.createdAt * 1000 : message.createdAt), 0);
  // ponytail: an open thread counts as read even when scrolled up; per-message visibility if that matters.
  if (latest) { try { localStorage.setItem(SEEN_KEY, JSON.stringify({ ...seen, [sessionId]: Math.max(latest, seen[sessionId] ?? 0) })); } catch { /* Seen markers reset next launch. */ } }
}

function timestamp(value: number): number { return value < 1e12 ? value * 1000 : value; }

function paintBotMessages(transcript: HTMLElement, messages: SavedMessage[], markers: BotMessageMarker[]): void {
  transcript.querySelectorAll(':scope > .bot-collab-group').forEach(marker => marker.remove());
  const ordered = [...markers].sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt) || a.id.localeCompare(b.id));
  const groups: BotMessageMarker[][] = [];
  for (const marker of ordered) {
    const group = groups.at(-1), previous = group?.at(-1);
    const separated = previous && messages.some(message => {
      const at = timestamp(message.createdAt);
      return at > timestamp(previous.createdAt) && at <= timestamp(marker.createdAt);
    });
    if (!group || separated) groups.push([marker]);
    else group.push(marker);
  }
  const byId = new Map(messages.map(message => [String(message.id), message]));
  const articles = [...transcript.querySelectorAll<HTMLElement>(':scope > article.message[data-message-id]')];
  for (const group of groups) {
    const firstAt = timestamp(group[0].createdAt);
    const next = articles.find(article => {
      const message = byId.get(article.dataset.messageId ?? '');
      return message && timestamp(message.createdAt) >= firstAt;
    });
    const html = collaborationGroupHtml(group);
    if (next) next.insertAdjacentHTML('beforebegin', html);
    else {
      const stream = transcript.querySelector('#stream-region');
      if (stream) stream.insertAdjacentHTML('beforebegin', html);
      else transcript.insertAdjacentHTML('beforeend', html);
    }
  }
}

function collaborationGroupHtml(group: BotMessageMarker[]): string {
  if (group.length > 1) {
    const names = [...new Set(group.map(marker => marker.botName))];
    return `<details class="bot-collab-group"><summary>${group.length} messages with ${names.map(escape).join(', ')}</summary><div class="bot-collab-items">${group.map(marker => collaborationItemHtml(marker)).join('')}</div></details>`;
  }
  const marker = group[0];
  return `<details class="bot-collab-group"><summary><span>${escape(collaborationLabel(marker))}</span><span class="bot-collab-status">${escape(marker.status)}</span></summary><div class="bot-collab-body">${collaborationBody(marker)}</div></details>`;
}

function collaborationLabel(marker: BotMessageMarker): string {
  return marker.kind === 'sent' ? `Messaged ${marker.botName}` : marker.kind === 'received' ? `Message from ${marker.botName}` : `Update from ${marker.botName}`;
}
function collaborationBody(marker: BotMessageMarker): string {
  return `${botAvatarHtml(marker.avatar, marker.botName, 'bot-collab-avatar', marker.color)}<div class="bot-collab-copy">${escape(marker.text)}${marker.result && marker.kind !== 'update' ? `<p>${escape(marker.result)}</p>` : ''}</div>`;
}
function collaborationItemHtml(marker: BotMessageMarker): string {
  return `<details class="bot-collab-item"><summary><span>${escape(collaborationLabel(marker))}</span><span class="bot-collab-status">${escape(marker.status)}</span></summary><div class="bot-collab-body">${collaborationBody(marker)}</div></details>`;
}

/** A model change is a compact system row at the activity's chronological position. */
function paintModelSwitches(transcript: HTMLElement, byId: Map<string, SavedMessage>, switches: Activity[]): void {
  transcript.querySelectorAll(':scope > .model-switch-marker').forEach(marker => marker.remove());
  const articles = [...transcript.querySelectorAll<HTMLElement>(':scope > article.message[data-message-id]')];
  for (const activity of [...switches].sort((a, b) => a.at - b.at)) {
    const markerTime = timestamp(activity.at);
    const next = articles.find(article => {
      const message = byId.get(article.dataset.messageId ?? '');
      return message && timestamp(message.createdAt) >= markerTime;
    });
    const html = modelSwitchMarkerHtml(activity);
    if (next) next.insertAdjacentHTML('beforebegin', html);
    else {
      const stream = transcript.querySelector('#stream-region');
      if (stream) stream.insertAdjacentHTML('beforebegin', html);
      else transcript.insertAdjacentHTML('beforeend', html);
    }
  }
}

/** The Ask-first card stays above the bot's ordinary composer. */
export function failoverHtml(ask: FailoverAsk | undefined): string {
  return ask ? failoverCardHtml(ask) : '';
}

/** A finished turn's work folds into "4 steps · 12s" (and "1 failed") above the answer. */
const folded = new Set<string>();
function decorateSteps(transcript: HTMLElement): void {
  for (const turn of transcript.querySelectorAll<HTMLElement>(':scope > .turn-activity:not(.live-activity)')) {
    const steps = turn.querySelectorAll('.turn-activity-body [data-tool-key]').length, failed = turn.querySelectorAll('.turn-activity-body [data-tool-status="failed"]').length;
    const label = turn.querySelector<HTMLElement>('.turn-activity-label');
    if (!steps || !label) continue;
    // Folded traces keep "Worked for 12s" in the summary's title; older ones in the label.
    const said = turn.querySelector('.turn-activity-summary')?.getAttribute('title') ?? label.textContent ?? '';
    const duration = /for (?:about )?(.+)$/.exec(said)?.[1];
    label.textContent = `${steps} ${steps === 1 ? 'step' : 'steps'}${duration ? ` · ${duration}` : ''}`;
    turn.classList.add('bot-steps');
    // A turn folds once when it finishes (the live run was open); after that the reader decides.
    const key = turn.dataset.turnKey ?? '';
    if (!folded.has(key) && localStorage.getItem('pandacode.activityExpanded') !== 'true') (turn as HTMLDetailsElement).open = false;
    folded.add(key);
    if (failed) label.insertAdjacentHTML('afterend', `<span class="bot-steps-failed">${failed} failed</span>`);
  }
}

function paintJump(transcript: HTMLElement): void {
  const pane = transcript.parentElement!;
  let pill = pane.querySelector<HTMLButtonElement>('.bot-jump');
  if (!unseen) { pill?.remove(); return; }
  if (!pill) { transcript.insertAdjacentHTML('afterend', '<button type="button" class="bot-jump"></button>'); pill = pane.querySelector<HTMLButtonElement>('.bot-jump')!; }
  pill.textContent = `${unseen} new ${unseen === 1 ? 'message' : 'messages'}`;
}

function quoteOf(article: HTMLElement): string {
  const content = article.querySelector<HTMLElement>('.message-content')?.cloneNode(true) as HTMLElement | undefined;
  content?.querySelectorAll('details').forEach(node => node.remove());
  const text = (content?.textContent ?? '').trim().replace(/\n{2,}/g, '\n');
  const short = text.length > 200 ? `${text.slice(0, 200).trimEnd()}…` : text;
  return short.split('\n').map(line => `> ${line}`).join('\n') + '\n\n';
}

function prompt(): HTMLTextAreaElement | null { return document.querySelector<HTMLTextAreaElement>('#prompt'); }
function setPrompt(value: string): void {
  const field = prompt(); if (!field) return;
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.focus(); field.setSelectionRange(value.length, value.length);
}

/** "Replying to {name}" above the prompt; call after the composer renders. */
export function paintReplyChip(sessionId: string): void {
  const composer = document.querySelector<HTMLElement>('#composer'), field = prompt();
  composer?.querySelector('.bot-reply-chip')?.remove();
  // A sent (or rewritten) prompt drops the reply with its quote.
  if (reply && field && !field.value.startsWith(reply.quote)) reply = undefined;
  if (!composer || !field || reply?.sessionId !== sessionId) return;
  field.insertAdjacentHTML('beforebegin', `<div class="bot-reply-chip">${REPLY}<span>Replying to ${escape(reply.author)}</span><button type="button" data-bot-reply-cancel aria-label="Cancel reply">${icon('close')}</button></div>`);
  composer.querySelector('[data-bot-reply-cancel]')!.addEventListener('click', () => {
    const quote = reply?.quote ?? '', value = prompt()?.value ?? '';
    reply = undefined;
    if (quote && value.startsWith(quote)) setPrompt(value.slice(quote.length));
    paintReplyChip(sessionId);
  });
}

function bind(transcript: HTMLElement): void {
  if (bound === transcript) return;
  bound = transcript;
  transcript.addEventListener('scroll', () => { if (unseen && nearBottom(transcript)) { unseen = 0; paintJump(transcript); } }, { passive: true });
  transcript.parentElement!.addEventListener('click', event => {
    if (!(event.target as Element).closest('.bot-jump')) return;
    unseen = 0; paintJump(transcript);
    transcript.scrollTop = transcript.scrollHeight;
  });
  transcript.addEventListener('click', event => {
    const target = event.target as Element, article = target.closest<HTMLElement>('article.message');
    if (!article || !article.closest('.bot-thread')) return;
    const key = article.dataset.reactionKey ?? '';
    if (target.closest('[data-bot-reply]')) {
      const author = article.classList.contains('user-message') ? 'You' : article.querySelector('.message-meta strong')?.textContent ?? 'Bot';
      const quote = quoteOf(article), field = prompt();
      const base = reply && field?.value.startsWith(reply.quote) ? field.value.slice(reply.quote.length) : field?.value ?? '';
      reply = { sessionId: opened, author, quote };
      setPrompt(quote + base);
      paintReplyChip(opened);
    } else if (target.closest('[data-bot-react]')) {
      const menu = article.querySelector<HTMLElement>('.bot-react-menu')!, button = target.closest<HTMLElement>('[data-bot-react]')!;
      menu.hidden = !menu.hidden; button.setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden) menu.querySelector<HTMLElement>('button')?.focus();
    } else if (target.closest('[data-bot-emoji]')) {
      const emoji = target.closest<HTMLElement>('[data-bot-emoji]')!.dataset.botEmoji!, list = reactionsFor(key);
      setReactions(key, list.includes(emoji) ? list : [...list, emoji]);
      repaintReactions(article, key);
    } else if (target.closest('[data-bot-unreact]')) {
      const emoji = target.closest<HTMLElement>('[data-bot-unreact]')!.dataset.botUnreact!;
      setReactions(key, reactionsFor(key).filter(item => item !== emoji));
      repaintReactions(article, key);
    }
  });
}
function repaintReactions(article: HTMLElement, key: string): void {
  article.querySelector('.bot-reactions')?.remove();
  const menu = article.querySelector<HTMLElement>('.bot-react-menu');
  if (menu) { menu.hidden = true; article.querySelector('[data-bot-react]')?.setAttribute('aria-expanded', 'false'); }
  article.querySelector(':scope > .message-actions')?.insertAdjacentHTML('beforebegin', reactionsHtml(key));
}

// ---- The working indicator below the last message while a turn runs.
const labels = new WeakMap<object, string>();
const activity = new WeakMap<object, { mark: string; at: number }>();
let lastLabel = '';
let timer = 0;
let live: { region: HTMLElement; bot: Bot; provider: string; run: () => BotRun | undefined } | undefined;

/** One label per turn, picked at random and never the same twice in a row. */
export function pickLabel(previous: string, random = Math.random): string {
  const choices = WORKING_LABELS.filter(label => label !== previous);
  return choices[Math.floor(random() * choices.length)];
}

/** Paints (or removes) the indicator in the stream region; `run` reads the live turn each second. */
export function paintWorking(region: HTMLElement, bot: Bot, provider: string, run: () => BotRun | undefined, finishing: boolean): void {
  const current = finishing ? undefined : run();
  region.classList.toggle('bot-live', Boolean(current));
  const message = region.querySelector<HTMLElement>('.live-message');
  if (message && !message.dataset.botDecorated) {
    message.dataset.botDecorated = 'true';
    const avatar = message.querySelector('.message-avatar'), name = message.querySelector('.message-meta strong');
    if (avatar) avatar.innerHTML = botAvatarHtml(bot.avatar, bot.name, 'bot-message-avatar', bot.color);
    if (name) name.textContent = bot.name;
  }
  let indicator = region.querySelector<HTMLElement>('.bot-working');
  if (!current) { indicator?.remove(); live = undefined; return; }
  if (!indicator) {
    region.insertAdjacentHTML('beforeend', `<div class="bot-working">${botAvatarHtml(bot.avatar, bot.name, 'bot-working-avatar', bot.color)}<span class="bot-working-label" aria-hidden="true"></span><span class="bot-working-elapsed" aria-hidden="true"></span><span class="sr-only" role="status" aria-live="polite"></span></div>`);
    indicator = region.querySelector<HTMLElement>('.bot-working')!;
  }
  if (region.lastElementChild !== indicator) region.append(indicator);
  live = { region, bot, provider, run };
  tick();
  if (!timer) timer = window.setInterval(tick, 1000);
}

function tick(): void {
  const current = live?.run(), indicator = live?.region.querySelector<HTMLElement>('.bot-working');
  if (!live || !current || !indicator?.isConnected) { clearInterval(timer); timer = 0; return; }
  const now = Date.now();
  if (!labels.has(current)) { lastLabel = pickLabel(lastLabel); labels.set(current, lastLabel); }
  const mark = `${current.revision}:${current.text.length}:${current.status}`, seen = activity.get(current);
  if (!seen || seen.mark !== mark) activity.set(current, { mark, at: seen ? now : current.startedAt });
  const waiting = current.approvals.size > 0 || current.inputs.size > 0;
  const stalled = !waiting && now - activity.get(current)!.at > STALL_MS;
  const progress = GENERIC_STATUS.has(current.status) ? '' : current.status;
  const label = stalled ? `Waiting for ${live.provider}…` : progress || labels.get(current)!;
  indicator.toggleAttribute('data-shimmer', !stalled && !waiting);
  const text = indicator.querySelector<HTMLElement>('.bot-working-label')!, elapsed = indicator.querySelector<HTMLElement>('.bot-working-elapsed')!;
  if (text.textContent !== label) {
    text.textContent = label;
    indicator.querySelector<HTMLElement>('[role="status"]')!.textContent = `${live.bot.name} is working: ${label}`;
  }
  const duration = now - current.startedAt;
  elapsed.textContent = duration >= ELAPSED_AFTER_MS ? formatDuration(duration) : '';
}

// ---- A model picked mid-turn applies from the next turn.
export function nextModel(sessionId: string): ModelChoice | undefined { return nextModels.get(sessionId); }
export function setNextModel(sessionId: string, choice: ModelChoice | undefined): void {
  if (choice) nextModels.set(sessionId, choice); else nextModels.delete(sessionId);
}
