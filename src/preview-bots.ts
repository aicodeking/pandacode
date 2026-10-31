/** Browser preview for bots: in-memory sample data, no network, no channels. Native builds use src-tauri/src/bots. */
import type { Activity, Bot, BotDetail, BotInput, Channel, FailoverAsk, Memory, Pairing, Rule, Schedule, Thread } from './bots';
import type { Project, Session } from './types';
import type { SharedChannelDetail, SharedChannelMessage, SharedChannelSummary } from './bot-shared-channels';

export interface PreviewBotsHost {
  invoke<T>(command: string, args: Record<string, any>): Promise<T>;
  emit(name: string, event: unknown): void;
  addProject(name: string): Project;
}
interface Store { bot: Bot; memories: Memory[]; schedules: Schedule[]; channels: Channel[]; pairings: Pairing[]; threads: Thread[]; rules: Rule[]; activity: Activity[] }
const bots = new Map<string, Store>();
const failoverAsks = new Map<string, FailoverAsk>();
const sharedChannels = new Map<string, SharedChannelDetail>();
let activityId = 1;
/** Ordinary tasks started with a bot, and those that have had its brief. */
const taskBots = new Map<string, string>(), taskBriefed = new Set<string>();
const MINUTE = 60_000;
const MODES = ['ask', 'auto', 'plan', 'full'];

function store(id: string): Store { const found = bots.get(id); if (!found) throw new Error('This bot no longer exists.'); return found; }
function log(entry: Store, kind: string, summary: string): void { entry.activity.unshift({ id: activityId++, kind, summary, detail: {}, at: Date.now() }); }
function validate(input: BotInput): BotInput {
  const name = String(input.name ?? '').trim().slice(0, 60);
  if (!name) throw new Error('Give the bot a name.');
  if (!MODES.includes(input.mode)) throw new Error('Choose a permission mode for the bot.');
  if (!input.provider) throw new Error('Choose a harness and model for the bot.');
  return { ...input, name, role: String(input.role ?? '').trim(), soul: String(input.soul ?? '').trim(), avatar: /^(panda:\d|data:image\/)/.test(String(input.avatar ?? '')) ? String(input.avatar) : [...String(input.avatar ?? '')].slice(0, 4).join(''), heartbeatMinutes: Number(input.heartbeatMinutes) || 0 };
}
function nextRun(input: Pick<Schedule, 'kind' | 'intervalMinutes' | 'timeOfDay'>, runAt: number | null): number | null {
  const now = Date.now();
  if (input.kind === 'interval') return input.intervalMinutes && input.intervalMinutes >= 5 && input.intervalMinutes <= 10080 ? now + input.intervalMinutes * MINUTE : null;
  if (input.kind === 'once') return runAt && runAt > now - MINUTE ? runAt : null;
  const match = /^(\d{2}):(\d{2})$/.exec(input.timeOfDay ?? '');
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  const next = new Date(); next.setHours(Number(match[1]), Number(match[2]), 0, 0);
  while (next.getTime() <= now || input.kind === 'weekdays' && [0, 6].includes(next.getDay())) next.setDate(next.getDate() + 1);
  return next.getTime();
}
function detail(entry: Store): BotDetail {
  return structuredClone({ bot: entry.bot, memories: entry.memories, schedules: entry.schedules, channels: entry.channels, pairings: entry.pairings, threads: entry.threads, rules: entry.rules, serverPort: 47321 });
}
function channelOf(id: string): [Store, Channel] {
  for (const entry of bots.values()) { const channel = entry.channels.find(item => item.id === id); if (channel) return [entry, channel]; }
  throw new Error('This channel no longer exists.');
}

/** A sample sender asks to pair shortly after a chat channel is added, so the flow can be tried. */
function simulatePairing(host: PreviewBotsHost, entry: Store, channel: Channel): void {
  if (channel.kind === 'web') return;
  window.setTimeout(() => {
    if (!entry.channels.includes(channel)) return;
    const pairing: Pairing = { channelId: channel.id, senderId: 'preview-sender', senderName: 'Sample sender', status: 'pending', code: '4821', createdAt: Date.now() };
    entry.pairings.unshift(pairing);
    host.emit('bot-pairing', { botId: entry.bot.id, channelId: channel.id, senderName: pairing.senderName, code: pairing.code });
    host.emit('bots-changed', null);
  }, 400);
}

/** Mirrors the native format checks; the preview never contacts a service. */
function previewIdentity(input: any): { name: string; link: string | null; invite: string | null; warnings: string[] } {
  const secret = (name: string) => String(input?.secrets?.[name] ?? '').trim();
  switch (input?.kind) {
    case 'telegram':
      if (!/^\d+:.{30,}$/.test(secret('token'))) throw new Error("That doesn't look like a Telegram bot token. It looks like 123456789:AAE… — copy the whole line BotFather sent.");
      return { name: '@preview_pandacode_bot', link: 'https://t.me/preview_pandacode_bot', invite: null, warnings: [] };
    case 'slack':
      if (secret('token').startsWith('xapp-') && secret('app_token').startsWith('xoxb-')) throw new Error('The two Slack tokens are swapped: the bot token starts with xoxb-, the app-level token with xapp-.');
      if (!secret('token').startsWith('xoxb-')) throw new Error('The bot token starts with xoxb-. Find it under OAuth & Permissions → Bot User OAuth Token (install the app first).');
      if (!secret('app_token').startsWith('xapp-')) throw new Error('The app-level token starts with xapp-. Create it under Basic Information → App-Level Tokens with the connections:write scope.');
      return { name: '@scout in Preview Workspace', link: 'https://preview.slack.com/', invite: null, warnings: [] };
    case 'discord':
      if (secret('token').split('.').length !== 3 || secret('token').length < 50) throw new Error("That doesn't look like a Discord bot token. In the Developer Portal open Bot → Reset Token and copy the whole value. (The Client Secret and Public Key are different values.)");
      return { name: 'Scout', link: null, invite: 'https://discord.com/oauth2/authorize?client_id=1234567890&scope=bot&permissions=274877975552', warnings: ['Message Content intent is off, so the bot cannot read messages. Turn it on at https://discord.com/developers/applications/1234567890/bot under Privileged Gateway Intents.'] };
    case 'whatsapp':
      if (!/^\d+$/.test(String(input?.config?.phoneNumberId ?? ''))) throw new Error('Enter the phone number ID (digits only) from WhatsApp → API Setup. It is not the phone number itself.');
      return { name: 'Preview Business (+1 555 0100)', link: 'https://wa.me/15550100', invite: null, warnings: [] };
    case 'web': return { name: 'Web chat on this computer', link: null, invite: null, warnings: [] };
    default: throw new Error('Choose web, Telegram, Slack, Discord or WhatsApp.');
  }
}

const briefed = new Set<string>();
async function desktopThread(host: PreviewBotsHost, entry: Store): Promise<Thread> {
  let thread = entry.threads.find(item => item.channelId === 'desktop');
  if (!thread) {
    const session = await host.invoke<Session>('create_session', { projectId: entry.bot.projectId, provider: entry.bot.provider, model: entry.bot.model, mode: entry.bot.mode });
    await host.invoke('update_session', { sessionId: session.id, title: `${entry.bot.name} · You` });
    thread = { channelId: 'desktop', externalId: 'desktop', sessionId: session.id, updatedAt: Date.now() };
    entry.threads.push(thread);
  }
  return thread;
}

/** Mirrors the native one-line preview of a bot conversation's latest message. */
async function lastMessage(host: PreviewBotsHost, sessionId: string): Promise<Bot['lastMessage']> {
  const page = await host.invoke<{ messages: { role: string; content: string; createdAt?: number; created_at?: number }[] }>('get_messages', { sessionId }).catch(() => null);
  const latest = [...(page?.messages ?? [])].reverse().find(message => (message.role === 'user' || message.role === 'assistant') && message.content.trim());
  if (!latest) return null;
  const line = latest.content.split(/\n\nBot brief:/)[0].replace(/[*_`#>]/g, '').split(/\s+/).filter(Boolean).join(' ');
  return { role: latest.role as 'user' | 'assistant', text: [...line].length > 160 ? [...line].slice(0, 160).join('') + '…' : line, at: latest.createdAt ?? latest.created_at ?? Date.now() };
}

const params = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
let sampled = false;
let sampleChannelSeeded = false;
/** Sample threads that look busy (their work is simulated by events, not a preview run), so a message waits in the queue as it would natively. */
const sampleBusy = new Set<string>();
/** Sample threads that show as working without a preview run behind them. */
export const previewBotBusy = (sessionId: string): boolean => sampleBusy.has(sessionId);
/** `?bots=sample` starts with four bots, one in each sidebar state: waiting for approval, working,
 *  at a usage limit, and paused. `?botsDelay=ms` holds the first list, to show the loading rows. */
async function seedSamples(host: PreviewBotsHost): Promise<void> {
  if (sampled || params.get('bots') !== 'sample') return;
  sampled = true;
  const base = { instructions: 'Sample bot.', goals: '', provider: 'claude', model: 'sonnet', mode: 'ask', heartbeatMinutes: 0 };
  const make = (name: string, role: string, avatar: string, profile: Partial<BotInput> = {}) => invokeBots<Bot>('bot_create', { input: { ...base, name, role, avatar, ...profile } }, host);
  const [waiting, working, limited, paused] = await Promise.all([make('Scout', 'Research', 'panda:5'), make('Writer', 'Drafts posts', 'panda:4'), make('Ledger', 'Finance', 'panda:7', { color: '#14b8a6', reasoningEffort: 'high', backupModels: [{ provider: 'codex', model: 'gpt-5' }], fallbackMode: 'auto', notify: false, whileWorking: 'steer', showPlan: true }), make('Dozy', 'Night shift', 'panda:8')]);
  if (!sampleChannelSeeded) {
    sampleChannelSeeded = true;
    const at = Date.now();
    sharedChannels.set('sample-launch', { id: 'sample-launch', name: 'launch', memberIds: [waiting.id, working.id, limited.id, paused.id], leadBotId: waiting.id, archived: false, updatedAt: at, activeBotIds: [], messages: [] });
  }
  await invokeBots('bot_set_paused', { botId: paused.id, paused: true }, host);
  const [ask, busy, capped] = await Promise.all([waiting, working, limited].map(bot => invokeBots<string>('bot_desktop_thread', { botId: bot.id }, host)));
  sampleBusy.add(ask); sampleBusy.add(busy);
  // Once the window has the new threads, they report live work like real runs do.
  window.setTimeout(() => {
    host.emit('agent-event', { sessionId: ask, kind: 'approval', requestId: 'sample-approval', text: 'Run `curl https://example.com`?' });
    host.emit('agent-event', { sessionId: busy, kind: 'status', text: 'Working…' });
    host.emit('agent-event', { sessionId: capped, kind: 'limited', text: 'Usage limit reached', data: { resetsAt: Date.now() + 3 * 3_600_000 } });
  }, 600);
}

/** Stops a sample channel's work (only `botIds`' assignments, when given), as Stop, archive and member removal do natively. */
function stopChannelWork(channel: SharedChannelDetail, botIds?: string[]): void {
  const mine = (item: SharedChannelDetail['messages'][number]) => !botIds || botIds.includes(item.authorBotId ?? '');
  for (const marker of channel.messages.filter(item => item.kind === 'assigned' && (item.status === 'In progress' || item.status === 'Queued') && mine(item))) marker.status = 'Stopped';
  const latest = [...channel.messages].reverse().find(item => item.kind === 'user' && item.status === 'In progress');
  channel.activeBotIds = channel.activeBotIds.filter(id => botIds && !botIds.includes(id));
  if (latest && !channel.activeBotIds.length) latest.status = 'Stopped';
}

export async function invokeBots<T>(command: string, args: Record<string, any>, host: PreviewBotsHost): Promise<T> {
  const changed = () => host.emit('bots-changed', null);
  let result: unknown = null;
  switch (command) {
    case 'bots_list': await seedSamples(host); if (params.has('botsDelay')) await new Promise(done => window.setTimeout(done, Number(params.get('botsDelay')) || 0)); result = await Promise.all([...bots.values()].map(async entry => {
      const desktopSession = entry.threads.find(thread => thread.channelId === 'desktop')?.sessionId ?? null;
      return { ...structuredClone(entry.bot), desktopSession, lastMessage: desktopSession ? await lastMessage(host, desktopSession) : null };
    })); break;
    case 'bot_desktop_thread': { const entry = store(args.botId); const known = entry.threads.length; result = (await desktopThread(host, entry)).sessionId; if (entry.threads.length !== known) { host.emit('sessions-changed', null); changed(); } break; }
    case 'bot_project_ids': result = [...bots.values()].map(entry => entry.bot.projectId); break;
    case 'bot_shared_channels': await seedSamples(host); result = [...sharedChannels.values()].map(({ messages: _messages, activeBotIds: _active, ...channel }) => structuredClone(channel)); break;
    case 'bot_shared_channel_detail': {
      const channel = sharedChannels.get(String(args.channelId));
      if (!channel) throw new Error('This channel no longer exists.');
      // Like the native side: the latest `limit` rows, and whether older ones exist.
      const limit = Math.max(1, Number(args.limit) || 100);
      result = { ...structuredClone(channel), messages: structuredClone(channel.messages.slice(-limit)), hasMore: channel.messages.length > limit }; break;
    }
    case 'bot_shared_channel_create': {
      const name = String(args.name ?? '').trim().replace(/^#+/, '').slice(0, 48);
      if (!name) throw new Error('Give the channel a name.');
      const memberIds = [...new Set(Array.isArray(args.memberIds) ? args.memberIds.map(String) : [])].filter(id => bots.has(id));
      const channel: SharedChannelDetail = { id: crypto.randomUUID(), name, memberIds, leadBotId: memberIds[0] ?? null, archived: false, updatedAt: Date.now(), activeBotIds: [], messages: [] };
      sharedChannels.set(channel.id, channel); result = structuredClone(channel); host.emit('bot-shared-channel-changed', { channelId: channel.id }); break;
    }
    case 'bot_shared_channel_update': {
      const channel = sharedChannels.get(String(args.channelId));
      if (!channel) throw new Error('This channel no longer exists.');
      if (channel.archived) throw new Error('This channel is deleted. Restore it to change it.');
      const memberIds = [...new Set(Array.isArray(args.memberIds) ? args.memberIds.map(String) : [])].filter(id => bots.has(id));
      const requested = String(args.leadBotId ?? '');
      channel.name = String(args.name ?? channel.name).trim().replace(/^#+/, '').slice(0, 48) || channel.name;
      const removed = channel.memberIds.filter(id => !memberIds.includes(id));
      if (removed.length) stopChannelWork(channel, removed);
      channel.memberIds = memberIds; channel.leadBotId = memberIds.includes(requested) ? requested : memberIds[0] ?? null; channel.updatedAt = Date.now();
      result = structuredClone(channel); host.emit('bot-shared-channel-changed', { channelId: channel.id }); break;
    }
    case 'bot_shared_channel_archive': {
      const channel = sharedChannels.get(String(args.channelId));
      if (!channel) throw new Error('This channel no longer exists.');
      if (args.archived) stopChannelWork(channel);
      channel.archived = Boolean(args.archived); channel.updatedAt = Date.now(); result = structuredClone(channel); host.emit('bot-shared-channel-changed', { channelId: channel.id }); break;
    }
    case 'bot_shared_channel_post': {
      const channel = sharedChannels.get(String(args.channelId));
      if (!channel || channel.archived) throw new Error('This channel is deleted.');
      const text = String(args.text ?? '').trim(); if (!text) throw new Error('Send some text.');
      const requested = Array.isArray(args.recipients) ? args.recipients.map(String) : [];
      const recipients = [...new Set(requested)].filter(id => channel.memberIds.includes(id)).slice(0, 2);
      if (!recipients.length && channel.leadBotId) recipients.push(channel.leadBotId);
      const id = crypto.randomUUID(), now = Date.now();
      // Test hook: a post mentioning this fails to start, as when a bot's harness cannot launch.
      const status = text.includes('[post-fails]') ? 'Failed' : 'In progress';
      channel.messages.push({ id, kind: 'user', authorBotId: null, text, status: recipients.length ? status : null, createdAt: now });
      for (const botId of recipients) channel.messages.push({ id: crypto.randomUUID(), kind: 'assigned', authorBotId: botId, text: `Assigned to ${store(botId).bot.name}`, status, createdAt: now });
      channel.activeBotIds = status === 'Failed' ? [] : recipients; channel.updatedAt = now; result = structuredClone(channel); host.emit('bot-shared-channel-changed', { channelId: channel.id }); break;
    }
    case 'bot_shared_channel_stop': {
      const channel = sharedChannels.get(String(args.channelId)); if (!channel) throw new Error('This channel no longer exists.');
      stopChannelWork(channel); result = structuredClone(channel); host.emit('bot-shared-channel-changed', { channelId: channel.id }); break;
    }
    case 'bot_shared_channel_continue':
    case 'bot_shared_channel_reassign': {
      const channel = sharedChannels.get(String(args.channelId)); if (!channel) throw new Error('This channel no longer exists.');
      const target = channel.messages.find(item => item.id === String(args.messageId)); if (!target || (target.status !== 'Stopped' && target.status !== 'Failed')) throw new Error('This message is no longer stopped.');
      const botId = command === 'bot_shared_channel_reassign' ? String(args.botId ?? '') : channel.leadBotId ?? channel.memberIds[0];
      if (!botId || !channel.memberIds.includes(botId)) throw new Error('Choose a channel member.');
      target.status = 'In progress'; channel.activeBotIds = [botId];
      channel.messages.push({ id: crypto.randomUUID(), kind: 'assigned', authorBotId: botId, text: `Assigned to ${store(botId).bot.name}`, status: 'In progress', createdAt: Date.now() });
      result = structuredClone(channel); host.emit('bot-shared-channel-changed', { channelId: channel.id }); break;
    }
    case 'bot_message_markers': result = []; break;
    case 'bot_failover_pending': result = failoverAsks.get(String(args.sessionId)) ?? null; break;
    case 'bot_model_switches': result = [...bots.values()].flatMap(entry => entry.activity).filter(item => item.kind === 'model-switch' && item.detail.sessionId === args.sessionId).sort((a, b) => a.at - b.at).slice(-200); break;
    case 'bot_failover_decide': {
      const sessionId = String(args.sessionId ?? ''), ask = failoverAsks.get(sessionId);
      if (!ask || !['send', 'wait'].includes(String(args.action))) throw new Error('This message is no longer on hold.');
      failoverAsks.delete(sessionId); result = null; changed(); break;
    }
    case 'bot_detail': result = detail(store(args.botId)); break;
    case 'bot_create': {
      const input = validate(args.input);
      const id = crypto.randomUUID(), now = Date.now();
      const project = host.addProject(input.name);
      const bot: Bot = { ...input, soul: input.soul ?? '', skills: [], mcp: [], id, projectId: project.id, paused: false, memoryVersion: 0, notifyChannelId: null, notifyThread: null, nextHeartbeatAt: input.heartbeatMinutes ? now + input.heartbeatMinutes * MINUTE : null, createdAt: now, updatedAt: now };
      const entry: Store = { bot, memories: [], schedules: [], channels: [], pairings: [], threads: [], rules: [], activity: [] };
      log(entry, 'created', `Created ${bot.name}`);
      bots.set(id, entry); result = structuredClone(bot); changed(); break;
    }
    case 'bot_update': {
      const entry = store(args.botId); const input = validate(args.input);
      entry.bot = { ...entry.bot, ...input, memoryVersion: entry.bot.memoryVersion + 1, updatedAt: Date.now() };
      log(entry, 'updated', 'Settings changed'); result = structuredClone(entry.bot); changed(); break;
    }
    case 'bot_set_paused': { const entry = store(args.botId); entry.bot = { ...entry.bot, paused: Boolean(args.paused), updatedAt: Date.now() }; log(entry, 'updated', args.paused ? 'Paused' : 'Resumed'); result = structuredClone(entry.bot); changed(); break; }
    case 'bot_reset': { const entry = store(args.botId); entry.memories = []; entry.schedules = []; entry.threads = []; entry.activity = []; log(entry, 'reset', 'Reset: conversations, memories and schedules cleared'); result = structuredClone(entry.bot); changed(); break; }
    case 'bot_delete': store(args.botId); bots.delete(args.botId); changed(); break;
    case 'bot_remember': {
      const entry = store(args.botId); const content = String(args.content ?? '').trim().slice(0, 2000);
      if (!content) throw new Error('A memory needs some text.');
      const existing = entry.memories.find(memory => memory.content.toLowerCase() === content.toLowerCase());
      const memory = existing ?? { id: crypto.randomUUID(), content, source: 'user' as const, createdAt: Date.now() };
      if (!existing) { entry.memories.push(memory); entry.bot.memoryVersion++; log(entry, 'memory', `Remembered: ${content.slice(0, 120)}`); }
      result = memory; changed(); break;
    }
    case 'bot_forget': { const entry = store(args.botId); const before = entry.memories.length; entry.memories = entry.memories.filter(memory => memory.id !== args.memoryId); if (before === entry.memories.length) throw new Error('That memory was already removed.'); log(entry, 'memory', 'Forgot a memory'); changed(); break; }
    case 'bot_activity': { const entry = store(args.botId); result = entry.activity.filter(item => args.before == null || item.id < args.before).slice(0, 100); break; }
    case 'bot_message': {
      const entry = store(args.botId); const text = String(args.text ?? '').trim();
      if (!text) throw new Error('Send some text.');
      if (entry.bot.paused) throw new Error('This bot is paused.');
      const thread = await desktopThread(host, entry);
      thread.updatedAt = Date.now();
      log(entry, 'inbound', `You (desktop): ${text.slice(0, 160)}`);
      // Like the native gateway, the first message of a thread carries the bot's brief; the transcript folds it.
      const brief = briefed.has(thread.sessionId) ? '' : `\n\nBot brief:\nYou are ${entry.bot.name}. ${entry.bot.instructions}${entry.bot.soul ? `\n\nPersonality (soul, from the user):\n${entry.bot.soul}` : ''}`.trimEnd();
      briefed.add(thread.sessionId);
      const prompt = text + brief, images = (args.imageIds ?? []).map((id: string) => ({ kind: 'image', id, name: 'Attached image' }));
      const task = await host.invoke<Session>('get_task', { sessionId: thread.sessionId });
      if (task.status === 'running' || task.status === 'waiting' || sampleBusy.has(thread.sessionId)) {
        if (args.forceQueue === true) {
          await host.invoke('queue_add', { sessionId: thread.sessionId, text: prompt, attachments: images });
          host.emit('queue-changed', { sessionId: thread.sessionId });
        } else if (entry.bot.whileWorking === 'steer' && !images.length && await host.invoke('steer_task', { sessionId: thread.sessionId, text: prompt }).then(() => true, () => false)) { /* Steered. */ }
        else {
          await host.invoke('queue_add', { sessionId: thread.sessionId, text: prompt, attachments: images });
          host.emit('queue-changed', { sessionId: thread.sessionId });
        }
      } else await host.invoke('send_message', { sessionId: thread.sessionId, text: prompt, imageIds: args.imageIds ?? [], moodboardIds: args.moodboardIds ?? [] });
      result = thread.sessionId; changed(); break;
    }
    case 'bot_set_capabilities': {
      const entry = store(args.botId);
      entry.bot = { ...entry.bot, skills: [...new Set<string>(args.skills ?? [])], mcp: [...new Set<string>(args.mcp ?? [])], memoryVersion: entry.bot.memoryVersion + 1, updatedAt: Date.now() };
      log(entry, 'updated', 'Skills and MCP servers changed'); result = structuredClone(entry.bot); changed(); break;
    }
    case 'bot_assign_task': {
      if ([...bots.values()].some(entry => entry.threads.some(thread => thread.sessionId === args.sessionId))) throw new Error('A bot\'s own conversations already use that bot.');
      taskBriefed.delete(args.sessionId);
      if (!args.botId) { taskBots.delete(args.sessionId); result = null; break; }
      result = structuredClone(store(args.botId).bot); taskBots.set(args.sessionId, args.botId); break;
    }
    case 'bot_task_links': result = Object.fromEntries(taskBots); break;
    case 'bot_task_brief': {
      const botId = taskBots.get(args.sessionId);
      if (!botId || taskBriefed.has(args.sessionId)) { result = null; break; }
      const bot = store(botId).bot; taskBriefed.add(args.sessionId);
      result = `\n\nBot brief:\nYou are ${bot.name}. ${bot.instructions}${bot.skills.length ? `\n\nSkills (from the PandaCode library):\n${bot.skills.map(id => `### ${id}`).join('\n')}` : ''}${bot.mcp.length ? `\n\nMCP servers chosen for this bot: ${bot.mcp.join(', ')}.` : ''}`;
      // Tests read the briefs sent, since the transcript hides them.
      ((globalThis as any).__botTaskBriefs ??= []).push({ sessionId: args.sessionId, brief: result });
      break;
    }
    case 'bot_schedule_create': {
      const entry = store(args.botId); const input = args.input ?? {};
      const prompt = String(input.prompt ?? '').trim();
      if (!prompt) throw new Error('A schedule needs a prompt: what should the bot do?');
      const next = nextRun(input, input.runAt ?? null);
      if (next == null) throw new Error('Check the schedule\'s time: intervals are 5 minutes to a week, times are HH:MM, one-off runs are within a year.');
      const schedule: Schedule = { id: crypto.randomUUID(), botId: entry.bot.id, title: String(input.title ?? '').trim() || prompt.slice(0, 60), prompt, kind: input.kind, intervalMinutes: input.intervalMinutes ?? null, timeOfDay: input.timeOfDay ?? null, nextRunAt: next, lastRunAt: null, enabled: true, createdBy: 'user', createdAt: Date.now() };
      entry.schedules.push(schedule); log(entry, 'schedule', `Scheduled: ${schedule.title}`); result = schedule; changed(); break;
    }
    case 'bot_schedule_set_enabled': {
      for (const entry of bots.values()) { const schedule = entry.schedules.find(item => item.id === args.scheduleId); if (schedule) { schedule.enabled = Boolean(args.enabled); schedule.nextRunAt = schedule.enabled ? nextRun(schedule, schedule.nextRunAt) : schedule.nextRunAt; result = schedule; } }
      if (!result) throw new Error('This schedule no longer exists.'); changed(); break;
    }
    case 'bot_schedule_delete': { const entry = store(args.botId); entry.schedules = entry.schedules.filter(item => item.id !== args.scheduleId); changed(); break; }
    case 'bot_run_schedule_now': {
      const entry = [...bots.values()].find(item => item.schedules.some(schedule => schedule.id === args.scheduleId));
      const schedule = entry?.schedules.find(item => item.id === args.scheduleId);
      if (!entry || !schedule) throw new Error('This schedule no longer exists.');
      if (entry.bot.paused) throw new Error('This bot is paused.');
      schedule.lastRunAt = Date.now(); log(entry, 'scheduled', `Scheduled: ${schedule.title}`); changed(); break;
    }
    case 'bot_channel_test': result = previewIdentity(args.input); break;
    case 'bot_channel_configure': {
      const [, channel] = channelOf(args.channelId);
      for (const [key, value] of Object.entries(args.config ?? {})) {
        if (key === 'remote' && channel.kind === 'web') channel.config = { ...channel.config, remote: Boolean(value) };
        else if (key === 'publicUrl' && ['web', 'whatsapp'].includes(channel.kind)) {
          const url = String(value ?? '').trim().replace(/\/+$/, '');
          if (url && !/^https:\/\/[^/?#@\s]+$/.test(url)) throw new Error('Use the https:// address your tunnel or Tailscale shows, without a path or query.');
          channel.config = { ...channel.config, publicUrl: url };
        } else throw new Error(`${key} cannot be changed for this channel.`);
      }
      result = channel; changed(); break;
    }
    case 'bot_channel_add': {
      const entry = store(args.botId); const input = args.input ?? {};
      const identity = previewIdentity(input);
      if (!['web', 'telegram', 'slack', 'discord', 'whatsapp'].includes(input.kind)) throw new Error('Choose web, Telegram, Slack, Discord or WhatsApp.');
      const required: Record<string, string[]> = { telegram: ['token'], discord: ['token'], slack: ['token', 'app_token'], whatsapp: ['access_token', 'signing_secret'], web: [] };
      if (input.kind === 'whatsapp' && !/^\d+$/.test(String(input.config?.phoneNumberId ?? ''))) throw new Error("Enter the WhatsApp phone number ID from Meta's API setup page.");
      for (const name of required[input.kind]) if (!String(input.secrets?.[name] ?? '').trim()) throw new Error(`Enter the ${name.replace('_', ' ')} for this channel.`);
      const config = { ...(input.config ?? {}), identity, ...(input.kind === 'whatsapp' ? { verifyToken: 'pandacode-preview0123456789' } : {}) };
      const channel: Channel = { id: crypto.randomUUID(), botId: entry.bot.id, kind: input.kind, label: String(input.label ?? '').trim(), config, enabled: true, status: input.kind === 'web' ? 'Ready on this computer' : 'Preview · not connected', secrets: required[input.kind] };
      entry.channels.push(channel); log(entry, 'channel', `Added a ${input.kind} channel`); result = channel; changed();
      simulatePairing(host, entry, channel); break;
    }
    case 'bot_channel_set_enabled': { const [, channel] = channelOf(args.channelId); channel.enabled = Boolean(args.enabled); channel.status = channel.enabled ? 'Preview · not connected' : 'Off'; result = channel; changed(); break; }
    case 'bot_channel_remove': { const [entry] = channelOf(args.channelId); entry.channels = entry.channels.filter(item => item.id !== args.channelId); entry.pairings = entry.pairings.filter(item => item.channelId !== args.channelId); log(entry, 'channel', 'Removed a channel'); changed(); break; }
    case 'bot_pairing_decide': {
      const [entry] = channelOf(args.channelId);
      if (!['approved', 'blocked', 'removed'].includes(args.decision)) throw new Error('Approve, block or remove the sender.');
      entry.pairings = args.decision === 'removed' ? entry.pairings.filter(item => !(item.channelId === args.channelId && item.senderId === args.senderId)) : entry.pairings.map(item => item.channelId === args.channelId && item.senderId === args.senderId ? { ...item, status: args.decision } : item);
      log(entry, 'pairing', `Sender ${args.decision}`); changed(); break;
    }
    case 'bot_web_new_link': { const [entry, channel] = channelOf(args.channelId); if (channel.kind !== 'web') throw new Error('Only web channels have a chat link.'); log(entry, 'channel', 'Created a new web chat link; old links stopped working'); changed(); result = `http://127.0.0.1:47321/chat/${channel.id}#preview-token-${crypto.randomUUID().slice(0, 8)}`; break; }
    case 'bot_web_link': { const [, channel] = channelOf(args.channelId); if (channel.kind !== 'web') throw new Error('Only web channels have a chat link.'); result = `http://127.0.0.1:47321/chat/${channel.id}#preview-token`; break; }
    case 'bot_rule_add': {
      const entry = store(args.botId); const pattern = String(args.pattern ?? '').trim().slice(0, 200);
      if (pattern.replaceAll('*', '').trim().length < 2) throw new Error('A rule needs a pattern of at least two characters.');
      if (!['allow', 'ask', 'deny'].includes(args.decision)) throw new Error('A rule allows, asks or denies.');
      const rule: Rule = { id: crypto.randomUUID(), pattern, decision: args.decision, createdAt: Date.now() };
      entry.rules.push(rule); log(entry, 'rule', `Rule: ${rule.decision} "${pattern}"`); result = rule; changed(); break;
    }
    case 'bot_rule_delete': { const entry = store(args.botId); entry.rules = entry.rules.filter(item => item.id !== args.ruleId); changed(); break; }
    default: throw new Error(`Unknown bot command: ${command}`);
  }
  return structuredClone(result) as T;
}
